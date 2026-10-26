import 'server-only';
import { httpJson } from '@/lib/providers/http';
import { env } from '@/lib/config/env';
import { db } from '@/lib/db/driver';

/**
 * Watchlist candidate ranking.
 *
 * WHAT THIS IS
 * ------------
 * A deterministic ranking of instruments by MEASURED market characteristics:
 * how much real money traded in the last 24 hours, how many separate trades
 * made up that volume, and how wide the day's range was.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a prediction, a forecast, or a profit claim, and it must never be
 * presented as one. A liquid, actively traded instrument is *easier to trade*
 * — you can get in and out near the quoted price. That is a statement about
 * market microstructure, not about whether the price will rise. Nothing here
 * looks at whether an instrument went up, except to report the number.
 *
 * All inputs come from keyless public endpoints, verified live:
 *   - Binance  `/api/v3/ticker/24hr`  — 3,739 symbols in one request
 *   - Indodax  `/api/summaries`       — 449 IDR pairs in one request
 *
 * Stocks are deliberately excluded: no configured free provider supplies
 * per-symbol volume for IDX or US equities, and ranking "tradability" without
 * volume would be a fabrication. The UI says so rather than showing a
 * confident-looking but baseless list.
 */

export type CandidateBand = 'liquid' | 'active' | 'speculative' | 'thin';

export type ReasonCode =
  | 'deepLiquidity'
  | 'tradeableLiquidity'
  | 'thinLiquidity'
  | 'manyTrades'
  | 'tradeCountUnavailable'
  | 'wideRange'
  | 'moderateRange'
  | 'narrowRange'
  | 'alreadyTracked';

/**
 * Derive the reason codes from the measured figures.
 *
 * Pure and exported so the thresholds are unit-testable and cannot drift from
 * what the UI claims.
 */
export function reasonCodes(
  quoteVolumeUsdEquivalent: number,
  rangePct: number,
  tradeCount: number | null,
): ReasonCode[] {
  const codes: ReasonCode[] = [];

  if (quoteVolumeUsdEquivalent >= 5_000_000) codes.push('deepLiquidity');
  else if (quoteVolumeUsdEquivalent >= 250_000) codes.push('tradeableLiquidity');
  else codes.push('thinLiquidity');

  if (tradeCount === null) codes.push('tradeCountUnavailable');
  else if (tradeCount >= 50_000) codes.push('manyTrades');

  if (rangePct >= 12) codes.push('wideRange');
  else if (rangePct >= 3) codes.push('moderateRange');
  else codes.push('narrowRange');

  return codes;
}

export interface Candidate {
  exchangeId: string;
  symbol: string;
  displayName: string;
  /** Currency the volume figure is denominated in. Never converted. */
  quoteCurrency: string;
  lastPrice: number;
  /** 24h turnover in the quote currency — the liquidity measure. */
  quoteVolume24h: number;
  /** (high - low) / open, as a percentage. Day range, not a forecast. */
  rangePct24h: number;
  /** 24h price change, reported for information only. */
  changePct24h: number;
  /** Number of individual trades, where the venue reports it. */
  tradeCount24h: number | null;
  band: CandidateBand;
  /** 0..1, composed only of liquidity and activity. See `scoreCandidate`. */
  tradabilityScore: number;
  /**
   * Why this ranked where it did, as STRUCTURED CODES.
   *
   * Codes rather than sentences because the app is bilingual and a Client
   * Component cannot be handed a translation function; the UI maps these to
   * `t.recommend.*`. Every code refers to a measured number on this record, so
   * the justification can always be checked against the figures shown.
   */
  reasons: ReasonCode[];
  alreadyTracked: boolean;
}

/**
 * Band an instrument by liquidity and day range.
 *
 * The thresholds are deliberately crude and stated in the UI, because a
 * precise-looking boundary would imply a precision the data does not support.
 */
export function bandOf(quoteVolumeUsdEquivalent: number, rangePct: number): CandidateBand {
  const liquid = quoteVolumeUsdEquivalent >= 5_000_000;
  const tradeable = quoteVolumeUsdEquivalent >= 250_000;
  if (liquid && rangePct < 12) return 'liquid';
  if (liquid) return 'active';
  if (tradeable) return 'speculative';
  return 'thin';
}

/**
 * Tradability score in 0..1.
 *
 * Only liquidity and trade activity contribute. Price direction deliberately
 * does NOT, so the ranking cannot be read as "these will go up". Log scales,
 * because turnover spans six orders of magnitude.
 */
export function scoreCandidate(quoteVolumeUsdEquivalent: number, tradeCount: number | null): number {
  const volScore = Math.min(1, Math.log10(Math.max(1, quoteVolumeUsdEquivalent)) / 9);
  if (tradeCount === null) return Number(volScore.toFixed(4));
  const actScore = Math.min(1, Math.log10(Math.max(1, tradeCount)) / 6.5);
  return Number((volScore * 0.7 + actScore * 0.3).toFixed(4));
}

/**
 * Assets that are pegged to a fiat currency by design.
 *
 * A stable-to-stable pair such as USDCUSDT is definitionally untradeable: it
 * is engineered not to move. It is also, on live data, the single most liquid
 * pair on the venue — so a pure liquidity ranking puts it first. Excluding
 * these by identity is more honest than tuning a range threshold until they
 * happen to fall off, because the reason is "this is a peg", not "this was
 * quiet today".
 *
 * Mirrors the stablecoin set in `lib/fx/service.ts`, plus the newer pegs
 * Binance has listed since.
 */
const PEGGED_ASSETS = new Set([
  'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD', 'USD1', 'USDP', 'PYUSD',
  'EURI', 'AEUR', 'XUSD', 'USDE', 'USDS',
]);

interface BinanceTicker {
  symbol: string;
  lastPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
  priceChangePercent: string;
  count: number;
}

function pct(high: number, low: number, open: number): number {
  if (!Number.isFinite(open) || open <= 0) return 0;
  return ((high - low) / open) * 100;
}

/** Binance USDT pairs, ranked by real 24h turnover. */
async function binanceCandidates(): Promise<Candidate[]> {
  const base = env().BINANCE_BASE_URL.replace(/\/$/, '');
  const rows = await httpJson<BinanceTicker[]>(`${base}/api/v3/ticker/24hr`, {
    timeoutMs: 60_000,
    maxBytes: 16 * 1024 * 1024,
  });

  return rows
    .filter((r) => r.symbol.endsWith('USDT'))
    .filter((r) => !PEGGED_ASSETS.has(r.symbol.replace(/USDT$/, '')))
    .map((r): Candidate | null => {
      const last = Number(r.lastPrice);
      const open = Number(r.openPrice);
      const qv = Number(r.quoteVolume);
      const range = pct(Number(r.highPrice), Number(r.lowPrice), open);
      if (!Number.isFinite(last) || !Number.isFinite(qv) || last <= 0) return null;
      return {
        exchangeId: 'BINANCE',
        symbol: r.symbol,
        displayName: `${r.symbol.replace(/USDT$/, '')}/USDT`,
        quoteCurrency: 'USDT',
        lastPrice: last,
        quoteVolume24h: qv,
        rangePct24h: range,
        changePct24h: Number(r.priceChangePercent),
        tradeCount24h: Number.isFinite(r.count) ? r.count : null,
        band: bandOf(qv, range),
        tradabilityScore: scoreCandidate(qv, Number.isFinite(r.count) ? r.count : null),
        reasons: reasonCodes(qv, range, Number.isFinite(r.count) ? r.count : null),
        alreadyTracked: false,
      };
    })
    .filter((c): c is Candidate => c !== null);
}

interface IndodaxSummaries {
  tickers: Record<
    string,
    { last: string; high: string; low: string; vol_idr: string; name?: string }
  >;
  prices_24h?: Record<string, string>;
}

/**
 * Indodax IDR pairs.
 *
 * Volume is in IDR. For BANDING ONLY it is converted to a rough USD
 * equivalent with a fixed divisor, because the bands are defined in USD. The
 * figure SHOWN to the user is always the untouched IDR number — this app does
 * not invent exchange rates for display.
 */
const IDR_PER_USD_ROUGH = 16_000;

async function indodaxCandidates(): Promise<Candidate[]> {
  const body = await httpJson<IndodaxSummaries>('https://indodax.com/api/summaries', {
    timeoutMs: 40_000,
    maxBytes: 8 * 1024 * 1024,
  });

  const out: Candidate[] = [];
  for (const [pair, t] of Object.entries(body.tickers ?? {})) {
    if (!pair.endsWith('_idr')) continue;
    const last = Number(t.last);
    const volIdr = Number(t.vol_idr);
    /*
     * `tickers` is keyed "btc_idr" but `prices_24h` is keyed "btcidr" — no
     * underscore. Looking it up with the ticker key silently missed every
     * time, fell back to the current price, and reported every 24h change as
     * exactly 0.00%.
     */
    const open = Number(body.prices_24h?.[pair.replace(/_/g, '')] ?? t.last);
    const range = pct(Number(t.high), Number(t.low), open);
    if (!Number.isFinite(last) || !Number.isFinite(volIdr) || last <= 0) continue;

    const usdEquivalent = volIdr / IDR_PER_USD_ROUGH;
    const change = Number.isFinite(open) && open > 0 ? ((last - open) / open) * 100 : 0;
    const bare = pair.replace(/_idr$/, '').toUpperCase();
    if (PEGGED_ASSETS.has(bare)) continue;
    out.push({
      exchangeId: 'INDODAX',
      symbol: `${bare}IDR`,
      displayName: t.name ? `${t.name} / Rupiah` : `${bare}/IDR`,
      quoteCurrency: 'IDR',
      lastPrice: last,
      quoteVolume24h: volIdr,
      rangePct24h: range,
      changePct24h: change,
      tradeCount24h: null,
      band: bandOf(usdEquivalent, range),
      tradabilityScore: scoreCandidate(usdEquivalent, null),
      reasons: reasonCodes(usdEquivalent, range, null),
      alreadyTracked: false,
    });
  }
  return out;
}

export interface RecommendOptions {
  exchange?: 'BINANCE' | 'INDODAX' | 'all';
  band?: CandidateBand | 'any';
  limit?: number;
  /**
   * Drop instruments whose 24h range is below this percentage.
   *
   * Defaults to 0.5%. Without it the top of the list filled with
   * stablecoin-to-stablecoin pairs — USDCUSDT and USD1USDT ranked 2nd and 8th
   * on live data with day ranges of 0.87% and 0.03%. They are genuinely the
   * most liquid things on the venue and genuinely pointless to trade, so
   * liquidity alone is the wrong filter. A peg that does not move offers no
   * entry or exit to plan around.
   */
  minRangePct?: number;
}

export interface RecommendResult {
  candidates: Candidate[];
  /** Venues that could not be reached, reported rather than hidden. */
  errors: { source: string; error: string }[];
  /** How many instruments were dropped for having a near-flat day range. */
  excludedFlatCount: number;
  minRangePct: number;
  generatedAtMs: number;
}

/** Symbols already on a watchlist, so they are not recommended again. */
async function trackedKeys(): Promise<Set<string>> {
  const d = await db();
  const rows = await d.all<{ symbol: string; exchange_id: string }>(
    `SELECT a.symbol, a.exchange_id FROM watchlist_assets wa JOIN assets a ON a.id = wa.asset_id`,
  );
  return new Set(rows.map((r) => `${r.exchange_id}:${r.symbol}`.toUpperCase()));
}

export async function recommendCandidates(opts: RecommendOptions = {}): Promise<RecommendResult> {
  const want = opts.exchange ?? 'all';
  const errors: { source: string; error: string }[] = [];
  let candidates: Candidate[] = [];

  if (want === 'all' || want === 'BINANCE') {
    try {
      candidates = candidates.concat(await binanceCandidates());
    } catch (err) {
      errors.push({ source: 'binance', error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (want === 'all' || want === 'INDODAX') {
    try {
      candidates = candidates.concat(await indodaxCandidates());
    } catch (err) {
      errors.push({ source: 'indodax', error: err instanceof Error ? err.message : String(err) });
    }
  }

  const tracked = await trackedKeys();
  for (const c of candidates) {
    c.alreadyTracked = tracked.has(`${c.exchangeId}:${c.symbol}`.toUpperCase());
    if (c.alreadyTracked) c.reasons = [...c.reasons, 'alreadyTracked'];
  }

  const minRange = opts.minRangePct ?? 0.5;
  const flatPegs = candidates.filter((c) => c.rangePct24h < minRange).length;
  candidates = candidates.filter((c) => c.rangePct24h >= minRange);

  if (opts.band && opts.band !== 'any') {
    candidates = candidates.filter((c) => c.band === opts.band);
  }

  candidates.sort((a, b) => b.tradabilityScore - a.tradabilityScore);
  const limited = candidates.slice(0, Math.min(opts.limit ?? 25, 100));

  return {
    candidates: limited,
    errors,
    excludedFlatCount: flatPegs,
    minRangePct: minRange,
    generatedAtMs: Date.now(),
  };
}
