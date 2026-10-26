import type { Candle, DataQuality, Timeframe } from './types';
import { TIMEFRAME_MS } from './types';

/**
 * Staleness policy.
 *
 * A dataset is considered usable only if its most recent CLOSED bar ended
 * recently enough relative to the bar size. The multiplier is intentionally
 * generous for higher timeframes and tight for scalping timeframes, because a
 * 1-minute strategy acting on 20-minute-old data is actively harmful while a
 * daily strategy tolerates hours of lag.
 *
 * `stale` does not mean "wrong" - it means "do not generate new entries from
 * this". The UI keeps displaying the data, clearly labelled.
 */
export const STALENESS_BAR_MULTIPLIER: Record<Timeframe, number> = {
  '1m': 3,
  '5m': 3,
  '15m': 3,
  '1h': 3,
  '4h': 2.5,
  '1d': 2.5,
  '1w': 2,
};

export interface FreshnessResult {
  quality: DataQuality;
  /** Age of the last closed candle's close time, in ms. */
  ageMs: number | null;
  /** Allowed age before the series is considered stale. */
  toleranceMs: number;
  lastClosedCandleMs: number | null;
  reason: string;
}

/**
 * Assess freshness of a candle series.
 *
 * `marketOpen = false` (an exchange outside trading hours) suppresses the
 * "stale" verdict, because a closed market legitimately produces no new bars.
 * Such data is reported as `delayed` instead, so the UI can say "market closed"
 * rather than "data problem".
 */
export function assessFreshness(
  candles: readonly Candle[],
  timeframe: Timeframe,
  nowMs: number,
  options: { minBars: number; marketOpen?: boolean },
): FreshnessResult {
  const toleranceMs = TIMEFRAME_MS[timeframe] * STALENESS_BAR_MULTIPLIER[timeframe];
  const closed = candles.filter((c) => !c.isPartial);

  if (candles.length === 0) {
    return {
      quality: 'unavailable',
      ageMs: null,
      toleranceMs,
      lastClosedCandleMs: null,
      reason: 'No candles returned by the provider.',
    };
  }
  if (closed.length < options.minBars) {
    return {
      quality: 'insufficient',
      ageMs: null,
      toleranceMs,
      lastClosedCandleMs: closed.at(-1)?.closeTimeMs ?? null,
      reason: `Only ${closed.length} closed bars available; ${options.minBars} required for this strategy.`,
    };
  }

  const last = closed.at(-1)!;
  const ageMs = nowMs - last.closeTimeMs;

  if (ageMs < 0) {
    // Provider clock ahead of ours, or a mislabelled partial bar.
    return {
      quality: 'invalid',
      ageMs,
      toleranceMs,
      lastClosedCandleMs: last.closeTimeMs,
      reason: 'Last candle closes in the future; provider timestamps are inconsistent.',
    };
  }
  if (ageMs > toleranceMs) {
    if (options.marketOpen === false) {
      return {
        quality: 'delayed',
        ageMs,
        toleranceMs,
        lastClosedCandleMs: last.closeTimeMs,
        reason: 'Market is closed; the last bar is the final bar of the previous session.',
      };
    }
    return {
      quality: 'stale',
      ageMs,
      toleranceMs,
      lastClosedCandleMs: last.closeTimeMs,
      reason: `Last closed bar is ${Math.round(ageMs / 60_000)} min old; tolerance is ${Math.round(toleranceMs / 60_000)} min.`,
    };
  }

  return {
    quality: 'ok',
    ageMs,
    toleranceMs,
    lastClosedCandleMs: last.closeTimeMs,
    reason: 'Latest closed bar is within the freshness tolerance.',
  };
}

/** Signals may only be generated from data of these qualities. */
export function canGenerateSignals(q: DataQuality): boolean {
  return q === 'ok';
}
