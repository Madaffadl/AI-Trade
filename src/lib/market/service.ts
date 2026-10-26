import 'server-only';
import { env } from '@/lib/config/env';
import { loadCandles, recordProviderError, recordProviderOk, saveCandles } from '@/lib/db/repo';
import { ProviderError } from '@/lib/providers/http';
import { providerSymbol, selectProvider } from '@/lib/providers/registry';
import { assessFreshness, type FreshnessResult } from './freshness';
import { markPartial } from './normalize';
import { sessionState } from './sessions';
import type { AssetRef, CandleSeries, DataQuality, Timeframe } from './types';

/**
 * Market-data service: the single entry point the rest of the app uses to get
 * candles. It owns the cache/fetch/fallback policy so no page or job has to.
 *
 * Policy:
 *   1. offline mode  -> database only, never the network.
 *   2. fresh cache   -> database only (avoids redundant provider calls when
 *                       navigating between pages).
 *   3. otherwise     -> fetch, persist, and return live data.
 *   4. fetch failure -> fall back to cached rows, relabelled with degraded
 *                       quality and an explicit error note. The app keeps
 *                       working; it never invents a price to fill the hole.
 */

export interface SeriesResult {
  series: CandleSeries | null;
  freshness: FreshnessResult | null;
  /** True when the data came from the local database rather than the provider. */
  fromCache: boolean;
  /** Set when the live fetch failed and cached data (or nothing) was returned. */
  providerError: string | null;
  session: ReturnType<typeof sessionState>;
  /** Quality after combining provider result, freshness, and session state. */
  quality: DataQuality;
  notes: string[];
  /** Concrete next step when no provider could serve this request. */
  remedy: string | null;
}

/** How long a stored series is reused before re-fetching, per timeframe. */
const CACHE_TTL_MS: Record<Timeframe, number> = {
  '1m': 45_000,
  '5m': 120_000,
  '15m': 300_000,
  '1h': 900_000,
  '4h': 1_800_000,
  '1d': 3_600_000,
  '1w': 21_600_000,
};

export interface FetchOptions {
  limit?: number;
  minBars?: number;
  /** Bypass the cache TTL (used by the scheduled refresh job). */
  force?: boolean;
  signal?: AbortSignal;
}

export async function getSeries(asset: AssetRef, timeframe: Timeframe, options: FetchOptions = {}): Promise<SeriesResult> {
  const limit = options.limit ?? 300;
  const minBars = options.minBars ?? 50;
  const now = Date.now();
  const holidays = await holidayList();
  const session = sessionState(asset.exchangeId, now, holidays);

  const cached = await loadCandles(asset.id, timeframe, limit);
  const cacheAge = cached.fetchedAtMs === null ? Infinity : now - cached.fetchedAtMs;

  // 1. Offline mode: database only.
  if (env().DATA_MODE === 'offline') {
    return finalize(asset, timeframe, cached.candles, cached.provider ?? 'cache', cached.fetchedAtMs, {
      fromCache: true,
      providerError: null,
      session,
      minBars,
      now,
      extraNotes: ['DATA_MODE=offline: serving stored candles only. No provider calls are made and no prices are synthesised.'],
    });
  }

  // 2. Cache still inside TTL.
  if (!options.force && cached.candles.length >= minBars && cacheAge < CACHE_TTL_MS[timeframe]) {
    return finalize(asset, timeframe, cached.candles, cached.provider ?? 'cache', cached.fetchedAtMs, {
      fromCache: true,
      providerError: null,
      session,
      minBars,
      now,
      extraNotes: [`Served from local cache (fetched ${Math.round(cacheAge / 1000)}s ago).`],
    });
  }

  // 3. Live fetch.
  const selection = selectProvider(asset.assetClass, asset.exchangeId, timeframe);
  if (!selection.ok) {
    const why = [selection.reason, ...selection.candidates.map((c) => `${c.id}: ${c.why}`)].join(' | ');
    if (cached.candles.length > 0) {
      return finalize(asset, timeframe, cached.candles, cached.provider ?? 'cache', cached.fetchedAtMs, {
        fromCache: true,
        providerError: why,
        session,
        minBars,
        now,
        extraNotes: ['Showing previously stored candles because no provider currently covers this request.'],
        remedy: selection.remedy,
      });
    }
    return {
      series: null,
      freshness: null,
      fromCache: false,
      providerError: why,
      session,
      quality: 'unavailable',
      notes: [why],
      remedy: selection.remedy,
    };
  }

  const provider = selection.provider;
  try {
    const symbol = providerSymbol(asset.symbol, asset.exchangeId, provider.id);
    const fresh = await provider.fetchCandles({ symbol, timeframe, limit, signal: options.signal });
    await recordProviderOk(provider.id, 'candles');
    await saveCandles(asset.id, timeframe, fresh.candles, provider.id, fresh.fetchedAtMs);

    // Merge with stored history so indicators get full warm-up even when a
    // provider returns only a short window (e.g. Nasdaq intraday).
    const merged = mergeSeries(cached.candles, fresh.candles);
    return finalize(asset, timeframe, merged, provider.id, fresh.fetchedAtMs, {
      fromCache: false,
      providerError: null,
      session,
      minBars,
      now,
      extraNotes: fresh.notes,
    });
  } catch (err) {
    const pe = err instanceof ProviderError ? err : new ProviderError(String(err), 'network');
    const retryUntil = pe.kind === 'rate_limited' ? now + (pe.retryAfterMs ?? 60_000) : undefined;
    await recordProviderError(provider.id, 'candles', pe.message, retryUntil);

    if (cached.candles.length > 0) {
      return finalize(asset, timeframe, cached.candles, cached.provider ?? 'cache', cached.fetchedAtMs, {
        fromCache: true,
        providerError: `${provider.id}: ${pe.message}`,
        session,
        minBars,
        now,
        extraNotes: [`Live fetch failed (${pe.kind}); showing the last successfully stored candles.`],
      });
    }
    return {
      series: null,
      freshness: null,
      fromCache: false,
      providerError: `${provider.id}: ${pe.message}`,
      session,
      quality: 'unavailable',
      notes: [`Provider ${provider.id} failed (${pe.kind}) and there is no cached data for this asset/timeframe.`],
      remedy: `Check provider status in Settings, then run: npm run providers:verify`,
    };
  }
}

/** Later-arriving candles win on timestamp collisions. */
function mergeSeries(stored: readonly import('./types').Candle[], fresh: readonly import('./types').Candle[]) {
  const map = new Map<number, import('./types').Candle>();
  for (const c of stored) map.set(c.openTimeMs, c);
  for (const c of fresh) map.set(c.openTimeMs, c);
  return [...map.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
}

function finalize(
  asset: AssetRef,
  timeframe: Timeframe,
  rawCandles: readonly import('./types').Candle[],
  provider: string,
  fetchedAtMs: number | null,
  ctx: {
    fromCache: boolean;
    providerError: string | null;
    session: ReturnType<typeof sessionState>;
    minBars: number;
    now: number;
    extraNotes: string[];
    remedy?: string | null;
  },
): SeriesResult {
  const candles = markPartial([...rawCandles], timeframe, ctx.now);
  const freshness = assessFreshness(candles, timeframe, ctx.now, {
    minBars: ctx.minBars,
    marketOpen: ctx.session.open,
  });

  let quality: DataQuality = freshness.quality;
  // A failed live fetch degrades 'ok' to 'delayed': the numbers are real, but
  // they are not current.
  if (ctx.providerError && quality === 'ok') quality = 'delayed';

  const notes = [...ctx.extraNotes];
  if (ctx.providerError) notes.push(`Provider issue: ${ctx.providerError}`);
  if (!ctx.session.open && 'reason' in ctx.session) notes.push(ctx.session.reason);

  return {
    series: {
      symbol: asset.symbol,
      exchangeId: asset.exchangeId,
      assetClass: asset.assetClass,
      timeframe,
      candles,
      provider,
      fetchedAtMs: fetchedAtMs ?? 0,
      quality,
      notes,
    },
    freshness,
    fromCache: ctx.fromCache,
    providerError: ctx.providerError,
    session: ctx.session,
    quality,
    notes,
    remedy: ctx.remedy ?? null,
  };
}

async function holidayList(): Promise<string[]> {
  const { getSetting } = await import('@/lib/db/repo');
  return getSetting<string[]>('market.holidays', []);
}
