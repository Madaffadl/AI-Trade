import type { Candle, Timeframe } from './types';
import { TIMEFRAME_MS } from './types';

export interface NormalizeReport {
  candles: Candle[];
  /** Candles dropped because a numeric field was not a finite positive number. */
  invalidDropped: number;
  /** Duplicate openTimeMs collapsed (later arrival wins). */
  duplicatesRemoved: number;
  /** Candles that arrived out of chronological order and were re-sorted. */
  reordered: boolean;
  /**
   * Missing bar slots inside the returned range. A gap is NOT filled with a
   * zero-movement candle - doing so would fabricate market data and corrupt
   * every indicator downstream. Gaps are reported and left as holes.
   */
  gaps: { fromMs: number; toMs: number; missingBars: number }[];
  warnings: string[];
}

function isValid(c: Candle): boolean {
  const nums = [c.open, c.high, c.low, c.close];
  if (!nums.every((n) => Number.isFinite(n) && n > 0)) return false;
  if (c.volume !== null && (!Number.isFinite(c.volume) || c.volume < 0)) return false;
  if (!Number.isFinite(c.openTimeMs) || !Number.isFinite(c.closeTimeMs)) return false;
  if (c.closeTimeMs <= c.openTimeMs) return false;
  // OHLC invariants: the high must be the maximum and the low the minimum.
  if (c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) return false;
  if (c.high < c.low) return false;
  return true;
}

/**
 * Normalise a raw provider response into a trustworthy series.
 *
 * Handles, in order: invalid values, duplicates, out-of-order arrival, and gap
 * detection. Everything it changes is reported so the UI and the signal engine
 * can decide whether the result is still good enough to act on.
 */
export function normalizeCandles(raw: readonly Candle[], timeframe: Timeframe): NormalizeReport {
  const warnings: string[] = [];
  const valid: Candle[] = [];
  let invalidDropped = 0;

  for (const c of raw) {
    if (isValid(c)) valid.push(c);
    else invalidDropped++;
  }
  if (invalidDropped > 0) {
    warnings.push(`${invalidDropped} candle(s) failed numeric/OHLC validation and were dropped.`);
  }

  // Detect out-of-order arrival before sorting.
  let reordered = false;
  for (let i = 1; i < valid.length; i++) {
    if (valid[i]!.openTimeMs < valid[i - 1]!.openTimeMs) {
      reordered = true;
      break;
    }
  }
  if (reordered) warnings.push('Provider returned candles out of chronological order; re-sorted.');

  // Deduplicate by openTimeMs, keeping the last occurrence (most recent data
  // for an in-progress bar).
  const byOpen = new Map<number, Candle>();
  let duplicatesRemoved = 0;
  for (const c of valid) {
    if (byOpen.has(c.openTimeMs)) duplicatesRemoved++;
    byOpen.set(c.openTimeMs, c);
  }
  if (duplicatesRemoved > 0) {
    warnings.push(`${duplicatesRemoved} duplicate candle timestamp(s) collapsed.`);
  }

  const candles = [...byOpen.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);

  // Gap detection. For 1d/1w series, missing slots are expected (weekends,
  // holidays, non-continuous markets), so gaps are only reported for intraday
  // timeframes where a missing bar is more likely to indicate a data problem.
  const gaps: NormalizeReport['gaps'] = [];
  const step = TIMEFRAME_MS[timeframe];
  const intraday = step < TIMEFRAME_MS['1d'];
  if (intraday) {
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1]!;
      const cur = candles[i]!;
      const delta = cur.openTimeMs - prev.openTimeMs;
      if (delta > step) {
        const missing = Math.round(delta / step) - 1;
        if (missing > 0) {
          gaps.push({ fromMs: prev.openTimeMs, toMs: cur.openTimeMs, missingBars: missing });
        }
      }
    }
    if (gaps.length > 0) {
      const total = gaps.reduce((s, g) => s + g.missingBars, 0);
      warnings.push(
        `${total} missing bar(s) across ${gaps.length} gap(s). Gaps are left as holes - they are NOT filled with flat candles.`,
      );
    }
  }

  return { candles, invalidDropped, duplicatesRemoved, reordered, gaps, warnings };
}

/**
 * Mark the final candle partial when its period has not yet elapsed.
 * Providers differ in whether they return the in-progress bar; this makes the
 * behaviour uniform so closed-bar strategy rules are never evaluated on a
 * half-formed candle.
 */
export function markPartial(candles: Candle[], timeframe: Timeframe, nowMs: number): Candle[] {
  const step = TIMEFRAME_MS[timeframe];
  return candles.map((c) => {
    const periodEnd = c.openTimeMs + step;
    return { ...c, isPartial: nowMs < periodEnd };
  });
}

/** Closed bars only - the input to every deterministic strategy rule. */
export function closedOnly(candles: readonly Candle[]): Candle[] {
  return candles.filter((c) => !c.isPartial);
}
