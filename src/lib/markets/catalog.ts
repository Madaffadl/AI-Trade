import 'server-only';
import { db } from '@/lib/db/driver';
import { nowMs } from '@/lib/db/repo';
import { httpJson, ProviderError } from '@/lib/providers/http';
import { env } from '@/lib/config/env';

/**
 * Instrument catalogue.
 *
 * Lists what the configured providers genuinely offer - all of it, not a
 * curated subset. Whether a thinly-traded micro-cap belongs on a watchlist is
 * the user's call; this layer's job is to show what exists, together with the
 * facts (market cap, change, lot size) needed to judge it.
 */

export interface CatalogRow {
  exchange_id: string;
  symbol: string;
  display_name: string;
  asset_class: string;
  currency: string;
  provider: string;
  last_price: number | null;
  market_cap: number | null;
  change_pct: number | null;
  volume: number | null;
  tick_size: number | null;
  lot_size: number | null;
  min_notional: number | null;
  fetched_at_ms: number;
}

export interface CatalogSyncResult {
  source: string;
  inserted: number;
  error: string | null;
}

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.nasdaq.com/',
};

/** "$1,234.56" / "5,349,477,000,000" / "2.541%" -> number | null */
function parseLoose(v: string | null | undefined): number | null {
  if (!v || typeof v !== 'string') return null;
  const cleaned = v.replace(/[$,%\s]/g, '');
  if (cleaned === '' || cleaned === 'NA' || cleaned === '--') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

async function upsert(rows: Omit<CatalogRow, 'fetched_at_ms'>[]): Promise<number> {
  if (rows.length === 0) return 0;
  const d = await db();
  const ts = nowMs();
  for (const r of rows) {
    await d.run(
      `INSERT INTO instrument_catalog
         (exchange_id, symbol, display_name, asset_class, currency, provider,
          last_price, market_cap, change_pct, volume, tick_size, lot_size, min_notional, fetched_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (exchange_id, symbol) DO UPDATE SET
         display_name = excluded.display_name,
         currency = excluded.currency,
         provider = excluded.provider,
         last_price = excluded.last_price,
         market_cap = excluded.market_cap,
         change_pct = excluded.change_pct,
         volume = excluded.volume,
         tick_size = excluded.tick_size,
         lot_size = excluded.lot_size,
         min_notional = excluded.min_notional,
         fetched_at_ms = excluded.fetched_at_ms`,
      [
        r.exchange_id,
        r.symbol,
        r.display_name,
        r.asset_class,
        r.currency,
        r.provider,
        r.last_price,
        r.market_cap,
        r.change_pct,
        r.volume,
        r.tick_size,
        r.lot_size,
        r.min_notional,
        ts,
      ],
    );
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Indodax: every IDR pair, including the small and illiquid ones. */
async function syncIndodax(): Promise<CatalogSyncResult> {
  try {
    const pairs = await httpJson<
      {
        symbol: string;
        description: string;
        base_currency: string;
        trade_min_traded_currency?: number;
        trade_min_base_currency?: number;
      }[]
    >('https://indodax.com/api/pairs', { timeoutMs: 30_000 });

    const rows = (pairs ?? []).map((p) => ({
      exchange_id: 'INDODAX',
      symbol: p.symbol.toUpperCase(),
      display_name: p.description ?? p.symbol,
      asset_class: 'crypto',
      currency: (p.base_currency ?? 'idr').toUpperCase(),
      provider: 'indodax',
      last_price: null,
      market_cap: null,
      change_pct: null,
      volume: null,
      tick_size: null,
      lot_size: p.trade_min_traded_currency ?? null,
      min_notional: p.trade_min_base_currency ?? null,
    }));
    return { source: 'indodax', inserted: await upsert(rows), error: null };
  } catch (err) {
    return { source: 'indodax', inserted: 0, error: describe(err) };
  }
}

/** Binance: all actively trading spot symbols. */
async function syncBinance(): Promise<CatalogSyncResult> {
  try {
    const info = await httpJson<{
      symbols: {
        symbol: string;
        status: string;
        baseAsset: string;
        quoteAsset: string;
        filters: { filterType: string; tickSize?: string; stepSize?: string; minNotional?: string }[];
      }[];
    }>(`${env().BINANCE_BASE_URL.replace(/\/$/, '')}/api/v3/exchangeInfo`, {
      timeoutMs: 60_000,
      // exchangeInfo is a genuinely large reference document (~18 MB and
      // growing). This is the one call that needs a raised cap; the default
      // 8 MB limit still guards every market-data request.
      maxBytes: 48 * 1024 * 1024,
    });

    const rows = (info.symbols ?? [])
      .filter((s) => s.status === 'TRADING')
      .map((s) => {
        const tick = s.filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize;
        const step = s.filters.find((f) => f.filterType === 'LOT_SIZE')?.stepSize;
        const minNotional = s.filters.find(
          (f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL',
        )?.minNotional;
        return {
          exchange_id: 'BINANCE',
          symbol: s.symbol,
          display_name: `${s.baseAsset}/${s.quoteAsset}`,
          asset_class: 'crypto',
          currency: s.quoteAsset,
          provider: 'binance',
          last_price: null,
          market_cap: null,
          change_pct: null,
          volume: null,
          tick_size: tick ? Number(tick) : null,
          lot_size: step ? Number(step) : null,
          min_notional: minNotional ? Number(minNotional) : null,
        };
      });
    return { source: 'binance', inserted: await upsert(rows), error: null };
  } catch (err) {
    return { source: 'binance', inserted: 0, error: describe(err) };
  }
}

/**
 * Nasdaq screener: the full US equity list WITH market capitalisation, which is
 * what makes a small/micro-cap filter possible at all.
 */
async function syncNasdaq(): Promise<CatalogSyncResult> {
  try {
    const raw = await httpJson<{
      data: {
        table?: { rows?: { symbol: string; name: string; lastsale: string; pctchange: string; marketCap: string }[] };
        rows?: { symbol: string; name: string; lastsale: string; pctchange: string; marketCap: string }[];
      } | null;
    }>('https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=false', {
      headers: BROWSER_HEADERS,
      timeoutMs: 60_000,
      maxBytes: 24 * 1024 * 1024,
    });

    const list = raw.data?.table?.rows ?? raw.data?.rows ?? [];
    const rows = list
      .filter((r) => r.symbol && /^[A-Z.\-]+$/i.test(r.symbol))
      .map((r) => ({
        exchange_id: 'US',
        symbol: r.symbol.toUpperCase().trim(),
        display_name: r.name ?? r.symbol,
        asset_class: 'stock',
        currency: 'USD',
        provider: 'nasdaq',
        last_price: parseLoose(r.lastsale),
        market_cap: parseLoose(r.marketCap),
        change_pct: parseLoose(r.pctchange),
        volume: null,
        tick_size: null,
        lot_size: null,
        min_notional: null,
      }));
    return { source: 'nasdaq', inserted: await upsert(rows), error: null };
  } catch (err) {
    return { source: 'nasdaq', inserted: 0, error: describe(err) };
  }
}

/** Twelve Data: Indonesian (IDX) listings. Requires a key. */
/**
 * IDX (Bursa Efek Indonesia) listings.
 *
 * Twelve Data's `/stocks` REFERENCE endpoint needs no API key — verified live:
 * `GET /stocks?country=Indonesia` returns 943 listings with real company names
 * at HTTP 200 with no credential at all. The key this adapter used to demand
 * is only required for CANDLES, which is a separate concern, so gating the
 * catalogue on it left Indonesian users with an empty product list for no
 * reason.
 *
 * Coverage here does not imply candle access on your plan — `npm run
 * providers:verify` answers that separately, and the UI says so.
 *
 * Other sources were tried and rejected: idx.co.id returns HTTP 403 to every
 * programmatic request (Incapsula), and Yahoo's search endpoint is
 * rate-limited per IP and starts refusing every host after a handful of calls.
 */
async function syncIdx(): Promise<CatalogSyncResult> {
  try {
    const raw = await httpJson<{
      data?: { symbol: string; name: string; currency: string; exchange: string; country: string; type?: string }[];
      status?: string;
      message?: string;
    }>('https://api.twelvedata.com/stocks?country=Indonesia', {
      timeoutMs: 40_000,
      maxBytes: 16 * 1024 * 1024,
    });

    if (raw.status === 'error') {
      return { source: 'twelvedata (IDX)', inserted: 0, error: raw.message ?? 'Provider returned an error.' };
    }

    const rows = (raw.data ?? [])
      // Keep real exchange-listed equities; the feed also carries other venues.
      .filter((d) => d.symbol && (d.exchange ?? '').toUpperCase() === 'IDX')
      .map((d) => ({
        exchange_id: 'IDX',
        symbol: d.symbol.toUpperCase().trim(),
        display_name: d.name ?? d.symbol,
        asset_class: 'stock',
        currency: (d.currency ?? 'IDR').toUpperCase(),
        provider: 'twelvedata',
        last_price: null,
        // The reference feed carries no price, cap or volume. Those stay null
        // rather than being filled with a plausible-looking number.
        market_cap: null,
        change_pct: null,
        volume: null,
        tick_size: null,
        lot_size: null,
        min_notional: null,
      }));

    if (rows.length === 0) {
      return { source: 'twelvedata (IDX)', inserted: 0, error: 'Provider returned no IDX listings.' };
    }
    return { source: 'twelvedata (IDX)', inserted: await upsert(rows), error: null };
  } catch (err) {
    return { source: 'twelvedata (IDX)', inserted: 0, error: describe(err) };
  }
}

function describe(err: unknown): string {
  return err instanceof ProviderError ? `${err.kind}: ${err.message}` : String(err);
}

/** Refresh every source. A failing source never blocks the others. */
export async function syncCatalog(): Promise<CatalogSyncResult[]> {
  return [await syncIndodax(), await syncBinance(), await syncNasdaq(), await syncIdx()];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type CapTier = 'any' | 'mega' | 'large' | 'mid' | 'small' | 'micro' | 'unknown';

/** Conventional US market-cap bands, in USD. */
export const CAP_BANDS: Record<Exclude<CapTier, 'any' | 'unknown'>, { min: number; max: number; label: string }> = {
  mega: { min: 200e9, max: Number.POSITIVE_INFINITY, label: '≥ $200B' },
  large: { min: 10e9, max: 200e9, label: '$10B – $200B' },
  mid: { min: 2e9, max: 10e9, label: '$2B – $10B' },
  small: { min: 300e6, max: 2e9, label: '$300M – $2B' },
  micro: { min: 0, max: 300e6, label: '< $300M' },
};

export interface CatalogFilter {
  assetClass?: 'crypto' | 'stock';
  exchangeId?: string;
  search?: string;
  capTier?: CapTier;
  currency?: string;
  limit?: number;
  offset?: number;
  sort?: 'symbol' | 'market_cap' | 'change';
}

export async function queryCatalog(filter: CatalogFilter = {}): Promise<{ rows: CatalogRow[]; total: number }> {
  const d = await db();
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.assetClass) {
    where.push('asset_class = ?');
    params.push(filter.assetClass);
  }
  if (filter.exchangeId) {
    where.push('exchange_id = ?');
    params.push(filter.exchangeId);
  }
  if (filter.currency) {
    where.push('currency = ?');
    params.push(filter.currency);
  }
  if (filter.search && filter.search.trim() !== '') {
    where.push('(UPPER(symbol) LIKE ? OR UPPER(display_name) LIKE ?)');
    const q = `%${filter.search.trim().toUpperCase()}%`;
    params.push(q, q);
  }
  if (filter.capTier && filter.capTier !== 'any') {
    if (filter.capTier === 'unknown') {
      where.push('market_cap IS NULL');
    } else {
      const band = CAP_BANDS[filter.capTier];
      where.push('market_cap IS NOT NULL AND market_cap >= ? AND market_cap < ?');
      params.push(band.min, Number.isFinite(band.max) ? band.max : Number.MAX_SAFE_INTEGER);
    }
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countRow = await d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM instrument_catalog ${clause}`, params);

  // `NULLS LAST` is not portable across both engines; the CASE form is.
  const order =
    filter.sort === 'market_cap'
      ? 'CASE WHEN market_cap IS NULL THEN 1 ELSE 0 END, market_cap DESC, symbol'
      : filter.sort === 'change'
        ? 'CASE WHEN change_pct IS NULL THEN 1 ELSE 0 END, change_pct DESC, symbol'
        : 'symbol';

  const rows = await d.all<CatalogRow>(
    `SELECT * FROM instrument_catalog ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...params, filter.limit ?? 100, filter.offset ?? 0],
  );

  return { rows, total: Number(countRow?.n ?? 0) };
}

export async function catalogStats(): Promise<{
  total: number;
  byExchange: { exchange_id: string; asset_class: string; n: number; fetched_at_ms: number }[];
}> {
  const d = await db();
  const total = await d.get<{ n: number }>('SELECT COUNT(*) AS n FROM instrument_catalog');
  const byExchange = await d.all<{ exchange_id: string; asset_class: string; n: number; fetched_at_ms: number }>(
    `SELECT exchange_id, asset_class, COUNT(*) AS n, MAX(fetched_at_ms) AS fetched_at_ms
     FROM instrument_catalog GROUP BY exchange_id, asset_class ORDER BY asset_class, exchange_id`,
  );
  return { total: Number(total?.n ?? 0), byExchange };
}

/**
 * Symbol search for the "add to watchlist" flow.
 *
 * Catalogue-first, deliberately. The previous implementation asked live
 * providers only, which meant:
 *   - every crypto query died on Binance's 18 MB `exchangeInfo` document
 *     exceeding the 8 MB response cap, and
 *   - every stock query returned an empty list with NO error, because no stock
 *     provider is configured by default — indistinguishable, in the UI, from
 *     "that symbol does not exist".
 *
 * The catalogue already holds every instrument the providers offer, locally, so
 * it answers instantly, offline, and without burning quota. Exact ticker
 * matches are ranked first, then prefix, then name substring.
 */
export async function searchCatalog(
  query: string,
  opts: { assetClass?: 'crypto' | 'stock'; limit?: number } = {},
): Promise<CatalogRow[]> {
  const q = query.trim().toUpperCase();
  if (q === '') return [];
  const limit = Math.min(opts.limit ?? 25, 50);

  const d = await db();
  const where: string[] = ['(upper(symbol) LIKE ? OR upper(display_name) LIKE ?)'];
  const params: unknown[] = [`%${q}%`, `%${q}%`];
  if (opts.assetClass) {
    where.push('asset_class = ?');
    params.push(opts.assetClass);
  }

  const rows = await d.all<CatalogRow>(
    `SELECT * FROM instrument_catalog
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE WHEN upper(symbol) = ? THEN 0
             WHEN upper(symbol) LIKE ? THEN 1
             ELSE 2 END,
        length(symbol),
        symbol
      LIMIT ?`,
    [...params, q, `${q}%`, limit],
  );
  return rows;
}
