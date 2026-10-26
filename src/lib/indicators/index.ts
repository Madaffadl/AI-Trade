/**
 * Deterministic technical indicators.
 *
 * Conventions used throughout:
 *   - Every function returns an array ALIGNED to the input length. Positions
 *     without enough warm-up data are `null`, never 0 and never back-filled.
 *     A null is a genuine "not computable yet", which the signal engine treats
 *     as a reason to refuse to fire rather than as a neutral value.
 *   - No function mutates its input.
 *   - No randomness, no clock access: identical inputs always yield identical
 *     outputs, which is what makes signals reproducible.
 *
 * These are pure functions with no server dependency so they can be unit tested
 * directly and reused in backtests.
 */

export type Series = readonly number[];
export type MaybeSeries = (number | null)[];

function requirePositiveInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v <= 0) throw new Error(`${name} must be a positive integer, received ${v}`);
}

/** Simple moving average. */
export function sma(values: Series, period: number): MaybeSeries {
  requirePositiveInt('period', period);
  const out: MaybeSeries = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` values
 * (the conventional seeding used by most charting platforms).
 */
export function ema(values: Series, period: number): MaybeSeries {
  requirePositiveInt('period', period);
  const out: MaybeSeries = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Relative Strength Index using Wilder's smoothing (the original definition).
 * The first value appears at index `period` because it needs `period` changes.
 */
export function rsi(values: Series, period = 14): MaybeSeries {
  requirePositiveInt('period', period);
  const out: MaybeSeries = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  // No losses in the window: RSI is defined as 100 (not a division by zero).
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: MaybeSeries;
  signal: MaybeSeries;
  histogram: MaybeSeries;
}

/** MACD. Signal line is an EMA of the MACD line, computed only where defined. */
export function macd(values: Series, fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine: MaybeSeries = values.map((_, i) => {
    const f = emaFast[i];
    const s = emaSlow[i];
    return f === null || s === null || f === undefined || s === undefined ? null : f - s;
  });

  const firstDefined = macdLine.findIndex((v) => v !== null);
  const signal: MaybeSeries = new Array(values.length).fill(null);
  const histogram: MaybeSeries = new Array(values.length).fill(null);

  if (firstDefined !== -1) {
    const dense = macdLine.slice(firstDefined).map((v) => v as number);
    const denseSignal = ema(dense, signalPeriod);
    for (let i = 0; i < denseSignal.length; i++) {
      const s = denseSignal[i];
      if (s === null || s === undefined) continue;
      const idx = firstDefined + i;
      signal[idx] = s;
      histogram[idx] = (macdLine[idx] as number) - s;
    }
  }
  return { macd: macdLine, signal, histogram };
}

export interface Bar {
  high: number;
  low: number;
  close: number;
}

/** True Range. Index 0 is null: it has no previous close. */
export function trueRange(bars: readonly Bar[]): MaybeSeries {
  const out: MaybeSeries = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const prevClose = bars[i - 1]!.close;
    out[i] = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  }
  return out;
}

/** Average True Range using Wilder's smoothing. */
export function atr(bars: readonly Bar[], period = 14): MaybeSeries {
  requirePositiveInt('period', period);
  const out: MaybeSeries = new Array(bars.length).fill(null);
  const tr = trueRange(bars);
  if (bars.length <= period) return out;

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i] as number;
  let prev = sum / period;
  out[period] = prev;

  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + (tr[i] as number)) / period;
    out[i] = prev;
  }
  return out;
}

export interface BollingerResult {
  middle: MaybeSeries;
  upper: MaybeSeries;
  lower: MaybeSeries;
  /** (upper - lower) / middle. A normalised width used for regime detection. */
  bandwidth: MaybeSeries;
  /** Where price sits within the bands: 0 = lower band, 1 = upper band. */
  percentB: MaybeSeries;
}

/** Bollinger Bands using the POPULATION standard deviation (the standard definition). */
export function bollinger(values: Series, period = 20, stdDevMultiplier = 2): BollingerResult {
  requirePositiveInt('period', period);
  const middle = sma(values, period);
  const upper: MaybeSeries = new Array(values.length).fill(null);
  const lower: MaybeSeries = new Array(values.length).fill(null);
  const bandwidth: MaybeSeries = new Array(values.length).fill(null);
  const percentB: MaybeSeries = new Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i++) {
    const mean = middle[i];
    if (mean === null || mean === undefined) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j]! - mean) ** 2;
    const sd = Math.sqrt(acc / period);
    const u = mean + stdDevMultiplier * sd;
    const l = mean - stdDevMultiplier * sd;
    upper[i] = u;
    lower[i] = l;
    bandwidth[i] = mean === 0 ? null : (u - l) / mean;
    percentB[i] = u === l ? 0.5 : (values[i]! - l) / (u - l);
  }
  return { middle, upper, lower, bandwidth, percentB };
}

/** Standard deviation of returns, annualisation deliberately omitted. */
export function stdDev(values: Series, period: number): MaybeSeries {
  requirePositiveInt('period', period);
  const means = sma(values, period);
  const out: MaybeSeries = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const mean = means[i];
    if (mean === null || mean === undefined) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j]! - mean) ** 2;
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

export interface VolumeAnalysis {
  /** Volume relative to its own moving average. null when volume is unavailable. */
  relativeVolume: MaybeSeries;
  average: MaybeSeries;
  /** True when the provider supplies no volume at all for this series. */
  unavailable: boolean;
}

/**
 * Volume analysis that refuses to guess.
 *
 * If the provider supplied no volume (e.g. Nasdaq intraday), every output is
 * null and `unavailable` is true, so volume-confirmation rules are skipped
 * rather than being satisfied by a fabricated zero.
 */
export function volumeAnalysis(volumes: readonly (number | null)[], period = 20): VolumeAnalysis {
  const usable = volumes.filter((v) => v !== null && Number.isFinite(v)).length;
  if (usable < period) {
    return {
      relativeVolume: new Array(volumes.length).fill(null),
      average: new Array(volumes.length).fill(null),
      unavailable: true,
    };
  }
  const dense = volumes.map((v) => (v === null || !Number.isFinite(v) ? 0 : v));
  const average = sma(dense, period);
  const relativeVolume: MaybeSeries = volumes.map((v, i) => {
    const avg = average[i];
    if (v === null || avg === null || avg === undefined || avg === 0) return null;
    return v / avg;
  });
  return { relativeVolume, average, unavailable: false };
}

export interface SwingLevels {
  /** Confirmed swing highs: a bar whose high exceeds `lookback` bars each side. */
  highs: { index: number; price: number }[];
  lows: { index: number; price: number }[];
  /** Nearest confirmed level above / below the reference price. */
  resistance: number | null;
  support: number | null;
}

/**
 * Support/resistance from confirmed swing pivots.
 *
 * A pivot is only confirmed once `lookback` bars have formed on BOTH sides, so
 * the most recent `lookback` bars can never produce a level. This avoids the
 * common lookahead bug where a level is "found" using bars that had not yet
 * occurred at signal time.
 */
export function swingLevels(bars: readonly { high: number; low: number }[], lookback = 5, referencePrice?: number): SwingLevels {
  const highs: { index: number; price: number }[] = [];
  const lows: { index: number; price: number }[] = [];

  for (let i = lookback; i < bars.length - lookback; i++) {
    const h = bars[i]!.high;
    const l = bars[i]!.low;
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j]!.high >= h) isHigh = false;
      if (bars[j]!.low <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, price: h });
    if (isLow) lows.push({ index: i, price: l });
  }

  const ref = referencePrice ?? bars.at(-1)?.high ?? null;
  let resistance: number | null = null;
  let support: number | null = null;
  if (ref !== null) {
    const above = highs.filter((p) => p.price > ref).map((p) => p.price);
    const below = lows.filter((p) => p.price < ref).map((p) => p.price);
    resistance = above.length > 0 ? Math.min(...above) : null;
    support = below.length > 0 ? Math.max(...below) : null;
  }
  return { highs, lows, resistance, support };
}

/** Highest high / lowest low over the last `period` bars, excluding the current bar. */
export function donchian(
  bars: readonly { high: number; low: number }[],
  period: number,
): { upper: MaybeSeries; lower: MaybeSeries } {
  requirePositiveInt('period', period);
  const upper: MaybeSeries = new Array(bars.length).fill(null);
  const lower: MaybeSeries = new Array(bars.length).fill(null);
  for (let i = period; i < bars.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period; j < i; j++) {
      hi = Math.max(hi, bars[j]!.high);
      lo = Math.min(lo, bars[j]!.low);
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

/** Percentage change between two prices, guarding against a zero base. */
export function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || from === 0 || !Number.isFinite(to)) return null;
  return ((to - from) / from) * 100;
}

/** Last defined (non-null) value of a series. */
export function last<T>(series: readonly (T | null)[]): T | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** Value at an index, normalising undefined to null. */
export function at(series: MaybeSeries, index: number): number | null {
  const v = series[index];
  return v === undefined ? null : v;
}
