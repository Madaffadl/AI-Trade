import 'server-only';
import { getSetting, setSetting, upsertAsset, upsertExchange } from '@/lib/db/repo';
import { getTradingSettings, type TradingSettings } from '@/lib/settings/trading';
import { fetchTickerAll, type IndodaxPairMeta, type IndodaxTicker } from './api';
import { getPairsMeta } from './meta';

/**
 * The scan universe: which Indodax IDR pairs are worth analysing at all.
 *
 * A pair is only worth a trade plan if it can actually be traded near its
 * quoted price. So the filter is about EXECUTION, never about which coins
 * "will go up": it must be an IDR pair, not a stablecoin, open for trading,
 * busy enough (24h turnover) and tight enough (bid/ask spread). BTC and ETH
 * are always kept as reference markets when they are tradable at all.
 *
 * Measured on 2026-10-28: only ~25 IDR pairs turned over Rp1 billion a day,
 * and spreads ran from ~0% (BTC) to 2.7% on thin altcoins - a 2.7% spread
 * alone would eat most of an hours-long trade's target.
 */

export type ExclusionReason =
  | 'not_idr'
  | 'pegged'
  | 'no_meta'
  | 'not_tradable'
  | 'no_quote'
  | 'low_volume'
  | 'wide_spread'
  | 'rank_cut';

export interface UniverseOptions {
  minVolumeIdr: number;
  maxSpreadPercent: number;
  maxPairs: number;
  /** Kept whenever tradable, regardless of volume/spread/rank. */
  alwaysInclude: readonly string[];
}

export interface UniverseCandidate {
  symbol: string;
  description: string;
  last: number;
  bid: number;
  ask: number;
  /** (ask - bid) / mid, in %. Null when there is no valid two-sided quote. */
  spreadPercent: number | null;
  volumeIdr: number | null;
  meta: IndodaxPairMeta | null;
  reason: ExclusionReason | null;
}

export const ALWAYS_INCLUDE = ['BTCIDR', 'ETHIDR'] as const;

/**
 * Coins pegged to a fiat currency by design. A stablecoin/IDR pair is engineered
 * not to move, so it offers no entry or exit to plan around - however liquid.
 */
export const PEGGED_ASSETS = new Set([
  'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD', 'USD1', 'USDP', 'PYUSD',
  'EURI', 'AEUR', 'XUSD', 'USDE', 'USDS',
]);

export function spreadPercent(bid: number, ask: number): number | null {
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  return ((ask - bid) / ((ask + bid) / 2)) * 100;
}

/** Pure: decide the universe from one ticker snapshot and the pair rules. */
export function selectUniverse(
  tickers: readonly IndodaxTicker[],
  meta: ReadonlyMap<string, IndodaxPairMeta>,
  opts: UniverseOptions,
): { included: UniverseCandidate[]; excluded: UniverseCandidate[] } {
  const always = new Set(opts.alwaysInclude);
  const eligible: UniverseCandidate[] = [];
  const excluded: UniverseCandidate[] = [];

  for (const t of tickers) {
    const m = meta.get(t.symbol) ?? null;
    const c: UniverseCandidate = {
      symbol: t.symbol,
      description: m?.description ?? t.symbol,
      last: t.last,
      bid: t.bid,
      ask: t.ask,
      spreadPercent: spreadPercent(t.bid, t.ask),
      volumeIdr: t.volumeIdr,
      meta: m,
      reason: null,
    };
    const asset = t.symbol.endsWith('IDR') ? t.symbol.slice(0, -3) : null;

    if (asset === null || (m && m.quote !== 'IDR')) c.reason = 'not_idr';
    else if (PEGGED_ASSETS.has(asset)) c.reason = 'pegged';
    else if (!m) c.reason = 'no_meta';
    else if (!m.tradable) c.reason = 'not_tradable';
    else if (c.spreadPercent === null || !(c.last > 0)) c.reason = 'no_quote';
    else if (!always.has(t.symbol) && (c.volumeIdr ?? 0) < opts.minVolumeIdr) c.reason = 'low_volume';
    else if (!always.has(t.symbol) && c.spreadPercent > opts.maxSpreadPercent) c.reason = 'wide_spread';

    (c.reason ? excluded : eligible).push(c);
  }

  // Reference markets first, then the busiest pairs.
  eligible.sort(
    (a, b) =>
      Number(always.has(b.symbol)) - Number(always.has(a.symbol)) || (b.volumeIdr ?? 0) - (a.volumeIdr ?? 0),
  );
  const included = eligible.slice(0, Math.max(opts.maxPairs, always.size));
  for (const c of eligible.slice(included.length)) excluded.push({ ...c, reason: 'rank_cut' });
  return { included, excluded };
}

export interface UniversePair {
  assetId: string;
  symbol: string;
  description: string;
  last: number;
  bid: number;
  ask: number;
  spreadPercent: number;
  volumeIdr: number | null;
  takerFeePercent: number;
  minOrderIdr: number | null;
  quantityIncrement: number | null;
  priceIncrement: number | null;
}

export interface UniverseSnapshot {
  generatedAtMs: number;
  /** Indodax's own clock on the ticker snapshot, when it reported one. */
  tickerServerTimeMs: number | null;
  pairs: UniversePair[];
  excludedCounts: Partial<Record<ExclusionReason, number>>;
  pairsMetaStale: boolean;
  filters: Pick<TradingSettings, 'minVolumeIdr' | 'maxSpreadPercent' | 'universeSize'>;
}

const SNAPSHOT_KEY = 'indodax.universe';

/** Fetch live tickers and pair rules, pick the universe, register its assets. */
export async function refreshUniverse(): Promise<UniverseSnapshot> {
  const settings = await getTradingSettings();
  const [{ tickers }, meta] = await Promise.all([fetchTickerAll(), getPairsMeta()]);
  const { included, excluded } = selectUniverse(tickers, meta.bySymbol, {
    minVolumeIdr: settings.minVolumeIdr,
    maxSpreadPercent: settings.maxSpreadPercent,
    maxPairs: settings.universeSize,
    alwaysInclude: ALWAYS_INCLUDE,
  });

  await upsertExchange({
    id: 'INDODAX',
    name: 'Indodax (Indonesian crypto exchange, IDR pairs)',
    asset_class: 'crypto',
    country: 'ID',
    timezone: 'Asia/Jakarta',
    continuous: true,
  });

  const pairs: UniversePair[] = [];
  for (const c of included) {
    const m = c.meta!;
    const asset = await upsertAsset({
      symbol: c.symbol,
      displayName: m.description,
      assetClass: 'crypto',
      exchangeId: 'INDODAX',
      currency: 'IDR',
      tickSize: m.priceIncrement,
      lotSize: m.quantityIncrement,
      minNotional: m.minOrderValue,
    });
    pairs.push({
      assetId: asset.id,
      symbol: c.symbol,
      description: m.description,
      last: c.last,
      bid: c.bid,
      ask: c.ask,
      spreadPercent: c.spreadPercent!,
      volumeIdr: c.volumeIdr,
      // Every IDR pair reported 0.2% on 2026-10-28; a missing figure is not
      // guessed lower - the published taker rate is the fallback.
      takerFeePercent: m.takerFeePct ?? 0.2,
      minOrderIdr: m.minOrderValue,
      quantityIncrement: m.quantityIncrement,
      priceIncrement: m.priceIncrement,
    });
  }

  const excludedCounts: Partial<Record<ExclusionReason, number>> = {};
  for (const c of excluded) excludedCounts[c.reason!] = (excludedCounts[c.reason!] ?? 0) + 1;

  const serverTimes = tickers.map((t) => t.serverTimeMs).filter((v): v is number => v !== null);
  const snapshot: UniverseSnapshot = {
    generatedAtMs: Date.now(),
    tickerServerTimeMs: serverTimes.length ? Math.max(...serverTimes) : null,
    pairs,
    excludedCounts,
    pairsMetaStale: meta.stale,
    filters: {
      minVolumeIdr: settings.minVolumeIdr,
      maxSpreadPercent: settings.maxSpreadPercent,
      universeSize: settings.universeSize,
    },
  };
  await setSetting(SNAPSHOT_KEY, snapshot);
  return snapshot;
}

/** The last stored universe, for pages (which never call the exchange themselves). */
export async function getUniverseSnapshot(): Promise<UniverseSnapshot | null> {
  return getSetting<UniverseSnapshot | null>(SNAPSHOT_KEY, null);
}
