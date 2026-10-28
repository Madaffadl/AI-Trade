import 'server-only';
import { db } from './driver';
import type { AssetClass, AssetRef, Candle, Timeframe } from '@/lib/market/types';

/**
 * Data access layer. All SQL lives here (plus signals/evaluation repos) so
 * pages and services never build queries inline.
 */

export const nowMs = (): number => Date.now();
export const newId = (): string => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Exchanges & assets
// ---------------------------------------------------------------------------

export interface ExchangeRow {
  id: string;
  name: string;
  asset_class: AssetClass;
  country: string | null;
  timezone: string;
  continuous: number;
}

export async function upsertExchange(row: Omit<ExchangeRow, 'continuous'> & { continuous: boolean }): Promise<void> {
  const d = await db();
  await d.run(
    `INSERT INTO exchanges (id, name, asset_class, country, timezone, continuous, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, timezone = excluded.timezone`,
    [row.id, row.name, row.asset_class, row.country, row.timezone, row.continuous ? 1 : 0, nowMs()],
  );
}

export async function listExchanges(): Promise<ExchangeRow[]> {
  const d = await db();
  return d.all<ExchangeRow>('SELECT * FROM exchanges ORDER BY asset_class, id');
}

interface AssetRow {
  id: string;
  symbol: string;
  display_name: string;
  asset_class: AssetClass;
  exchange_id: string;
  currency: string;
  tick_size: number | null;
  lot_size: number | null;
  min_notional: number | null;
  active: number;
}

const toAssetRef = (r: AssetRow): AssetRef => ({
  id: r.id,
  symbol: r.symbol,
  displayName: r.display_name,
  assetClass: r.asset_class,
  exchangeId: r.exchange_id,
  currency: r.currency,
  tickSize: r.tick_size,
  lotSize: r.lot_size,
  minNotional: r.min_notional,
});

export async function upsertAsset(a: Omit<AssetRef, 'id'> & { id?: string }): Promise<AssetRef> {
  const d = await db();
  const existing = await d.get<AssetRow>('SELECT * FROM assets WHERE exchange_id = ? AND symbol = ?', [
    a.exchangeId,
    a.symbol,
  ]);
  const id = existing?.id ?? a.id ?? newId();
  await d.run(
    `INSERT INTO assets (id, symbol, display_name, asset_class, exchange_id, currency, tick_size, lot_size, min_notional, active, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT (exchange_id, symbol) DO UPDATE SET
       display_name = excluded.display_name,
       currency = excluded.currency,
       -- A caller that does not know the exchange increments (e.g. adding to
       -- the watchlist from a search result) must not erase known ones.
       tick_size = COALESCE(excluded.tick_size, assets.tick_size),
       lot_size = COALESCE(excluded.lot_size, assets.lot_size),
       min_notional = COALESCE(excluded.min_notional, assets.min_notional),
       active = 1`,
    [
      id,
      a.symbol,
      a.displayName,
      a.assetClass,
      a.exchangeId,
      a.currency,
      a.tickSize,
      a.lotSize,
      a.minNotional,
      nowMs(),
    ],
  );
  const row = await d.get<AssetRow>('SELECT * FROM assets WHERE exchange_id = ? AND symbol = ?', [
    a.exchangeId,
    a.symbol,
  ]);
  return toAssetRef(row!);
}

export async function getAssetById(id: string): Promise<AssetRef | null> {
  const d = await db();
  const r = await d.get<AssetRow>('SELECT * FROM assets WHERE id = ?', [id]);
  return r ? toAssetRef(r) : null;
}

export async function getAssetBySymbol(symbol: string, exchangeId?: string): Promise<AssetRef | null> {
  const d = await db();
  const r = exchangeId
    ? await d.get<AssetRow>('SELECT * FROM assets WHERE symbol = ? AND exchange_id = ?', [symbol, exchangeId])
    : await d.get<AssetRow>('SELECT * FROM assets WHERE symbol = ? ORDER BY exchange_id LIMIT 1', [symbol]);
  return r ? toAssetRef(r) : null;
}

export async function listAssets(assetClass?: AssetClass): Promise<AssetRef[]> {
  const d = await db();
  const rows = assetClass
    ? await d.all<AssetRow>('SELECT * FROM assets WHERE active = 1 AND asset_class = ? ORDER BY symbol', [assetClass])
    : await d.all<AssetRow>('SELECT * FROM assets WHERE active = 1 ORDER BY asset_class, symbol');
  return rows.map(toAssetRef);
}

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

interface CandleRow {
  open_time_ms: number;
  close_time_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  is_partial: number;
  provider: string;
  fetched_at_ms: number;
}

/**
 * Persist candles. Partial (in-progress) bars are stored too - they are needed
 * for a live price - but they are flagged so strategies can exclude them.
 */
export async function saveCandles(
  assetId: string,
  timeframe: Timeframe,
  candles: readonly Candle[],
  provider: string,
  fetchedAtMs: number,
): Promise<number> {
  if (candles.length === 0) return 0;
  const d = await db();
  // Multi-row upserts: one statement per 200 candles instead of one per
  // candle. Scanning ~25 pairs on three timeframes writes thousands of rows
  // per cycle, and per-row statements made that the slowest part of a scan.
  const CHUNK = 200;
  for (let i = 0; i < candles.length; i += CHUNK) {
    const chunk = candles.slice(i, i + CHUNK);
    await d.run(
      `INSERT INTO market_candles
         (asset_id, timeframe, open_time_ms, close_time_ms, open, high, low, close, volume, provider, fetched_at_ms, is_partial, quality)
       VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')").join(', ')}
       ON CONFLICT (asset_id, timeframe, open_time_ms) DO UPDATE SET
         close_time_ms = excluded.close_time_ms,
         open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
         volume = excluded.volume, provider = excluded.provider,
         fetched_at_ms = excluded.fetched_at_ms, is_partial = excluded.is_partial`,
      chunk.flatMap((c) => [
        assetId,
        timeframe,
        c.openTimeMs,
        c.closeTimeMs,
        c.open,
        c.high,
        c.low,
        c.close,
        c.volume,
        provider,
        fetchedAtMs,
        c.isPartial ? 1 : 0,
      ]),
    );
  }
  return candles.length;
}

/** Earliest and latest stored candle for an asset and timeframe. */
export async function candleBounds(
  assetId: string,
  timeframe: Timeframe,
): Promise<{ minOpenMs: number | null; maxOpenMs: number | null; count: number }> {
  const d = await db();
  const row = await d.get<{ mn: number | null; mx: number | null; n: number }>(
    'SELECT MIN(open_time_ms) AS mn, MAX(open_time_ms) AS mx, COUNT(*) AS n FROM market_candles WHERE asset_id = ? AND timeframe = ?',
    [assetId, timeframe],
  );
  return { minOpenMs: row?.mn ?? null, maxOpenMs: row?.mx ?? null, count: Number(row?.n ?? 0) };
}

export interface StoredSeries {
  candles: Candle[];
  provider: string | null;
  fetchedAtMs: number | null;
}

export async function loadCandles(assetId: string, timeframe: Timeframe, limit: number): Promise<StoredSeries> {
  const d = await db();
  const rows = await d.all<CandleRow>(
    `SELECT * FROM market_candles WHERE asset_id = ? AND timeframe = ?
     ORDER BY open_time_ms DESC LIMIT ?`,
    [assetId, timeframe, limit],
  );
  const ordered = rows.slice().reverse();
  return {
    candles: ordered.map((r) => ({
      openTimeMs: r.open_time_ms,
      closeTimeMs: r.close_time_ms,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      isPartial: r.is_partial === 1,
    })),
    provider: ordered.at(-1)?.provider ?? null,
    fetchedAtMs: ordered.at(-1)?.fetched_at_ms ?? null,
  };
}

// ---------------------------------------------------------------------------
// Provider status
// ---------------------------------------------------------------------------

export interface ProviderStatusRow {
  provider: string;
  operation: string;
  last_ok_ms: number | null;
  last_error_ms: number | null;
  last_error: string | null;
  consecutive_failures: number;
  calls_today: number;
  calls_day_key: string | null;
  rate_limited_until_ms: number | null;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function recordProviderOk(provider: string, operation: string): Promise<void> {
  const d = await db();
  const ts = nowMs();
  const key = dayKey(ts);
  await d.run(
    `INSERT INTO provider_status (provider, operation, last_ok_ms, consecutive_failures, calls_today, calls_day_key)
     VALUES (?, ?, ?, 0, 1, ?)
     ON CONFLICT (provider, operation) DO UPDATE SET
       last_ok_ms = excluded.last_ok_ms,
       consecutive_failures = 0,
       rate_limited_until_ms = NULL,
       calls_today = CASE WHEN provider_status.calls_day_key = excluded.calls_day_key
                          THEN provider_status.calls_today + 1 ELSE 1 END,
       calls_day_key = excluded.calls_day_key`,
    [provider, operation, ts, key],
  );
}

export async function recordProviderError(
  provider: string,
  operation: string,
  error: string,
  rateLimitedUntilMs?: number,
): Promise<void> {
  const d = await db();
  const ts = nowMs();
  const key = dayKey(ts);
  await d.run(
    `INSERT INTO provider_status (provider, operation, last_error_ms, last_error, consecutive_failures, calls_today, calls_day_key, rate_limited_until_ms)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?)
     ON CONFLICT (provider, operation) DO UPDATE SET
       last_error_ms = excluded.last_error_ms,
       last_error = excluded.last_error,
       consecutive_failures = provider_status.consecutive_failures + 1,
       calls_today = CASE WHEN provider_status.calls_day_key = excluded.calls_day_key
                          THEN provider_status.calls_today + 1 ELSE 1 END,
       calls_day_key = excluded.calls_day_key,
       rate_limited_until_ms = excluded.rate_limited_until_ms`,
    [provider, operation, ts, error.slice(0, 400), key, rateLimitedUntilMs ?? null],
  );
}

/** Providers still cooling down for an operation, mapped to when they may be retried. */
export async function providerCooldowns(operation: string, now = nowMs()): Promise<Map<string, number>> {
  const d = await db();
  const rows = await d.all<{ provider: string; rate_limited_until_ms: number }>(
    'SELECT provider, rate_limited_until_ms FROM provider_status WHERE operation = ? AND rate_limited_until_ms > ?',
    [operation, now],
  );
  return new Map(rows.map((r) => [r.provider, Number(r.rate_limited_until_ms)]));
}

export async function listProviderStatus(): Promise<ProviderStatusRow[]> {
  const d = await db();
  return d.all<ProviderStatusRow>('SELECT * FROM provider_status ORDER BY provider, operation');
}

// ---------------------------------------------------------------------------
// Application settings (non-secret only)
// ---------------------------------------------------------------------------

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const d = await db();
  const row = await d.get<{ value_json: string }>('SELECT value_json FROM application_settings WHERE key = ?', [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const d = await db();
  await d.run(
    `INSERT INTO application_settings (key, value_json, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms`,
    [key, JSON.stringify(value), nowMs()],
  );
}

// ---------------------------------------------------------------------------
// Job runs
// ---------------------------------------------------------------------------

export async function startJob(job: string): Promise<string> {
  const d = await db();
  const id = newId();
  await d.run('INSERT INTO job_runs (id, job, started_at_ms, status) VALUES (?, ?, ?, ?)', [
    id,
    job,
    nowMs(),
    'running',
  ]);
  return id;
}

export async function finishJob(
  id: string,
  status: 'ok' | 'partial' | 'error',
  summary: unknown,
  error?: string,
): Promise<void> {
  const d = await db();
  await d.run('UPDATE job_runs SET finished_at_ms = ?, status = ?, summary_json = ?, error = ? WHERE id = ?', [
    nowMs(),
    status,
    JSON.stringify(summary),
    error?.slice(0, 500) ?? null,
    id,
  ]);
}

export async function listRecentJobs(limit = 10): Promise<
  { id: string; job: string; started_at_ms: number; finished_at_ms: number | null; status: string; summary_json: string | null; error: string | null }[]
> {
  const d = await db();
  return d.all('SELECT * FROM job_runs ORDER BY started_at_ms DESC LIMIT ?', [limit]);
}
