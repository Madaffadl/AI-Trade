import { atr, bollinger, ema, last, sma } from '@/lib/indicators';
import type { Candle, MarketRegime } from '@/lib/market/types';

/**
 * Deterministic market-regime classification.
 *
 * Every threshold here is explicit and documented in docs/SIGNAL_METHODOLOGY.md.
 * Regime does NOT by itself produce a BUY or SELL - it gates which strategies
 * are allowed to run (a mean-reversion setup is suppressed in a strong trend,
 * a breakout setup is suppressed in a dead-flat market).
 */

export interface RegimeConfig {
  /** EMA pair used for trend direction. */
  fastPeriod: number;
  slowPeriod: number;
  /** |fast - slow| / slow above this (as a fraction) counts as a real trend. */
  trendSeparation: number;
  /** ATR / close above this fraction is "high volatility". */
  highVolAtrPct: number;
  /** ATR / close below this fraction is "low volatility". */
  lowVolAtrPct: number;
  atrPeriod: number;
  bbPeriod: number;
}

export const DEFAULT_REGIME_CONFIG: RegimeConfig = {
  fastPeriod: 20,
  slowPeriod: 50,
  trendSeparation: 0.005, // 0.5% separation between the EMAs
  highVolAtrPct: 0.03, // ATR >= 3% of price
  lowVolAtrPct: 0.005, // ATR <= 0.5% of price
  atrPeriod: 14,
  bbPeriod: 20,
};

export interface RegimeResult {
  regime: MarketRegime;
  /** Every input that drove the classification, for display and auditing. */
  evidence: {
    emaFast: number | null;
    emaSlow: number | null;
    separationPct: number | null;
    atr: number | null;
    atrPct: number | null;
    bandwidth: number | null;
    slopePct: number | null;
  };
  explanation: string;
}

/** Minimum closed bars needed before a regime can be classified at all. */
export function regimeWarmup(cfg: RegimeConfig = DEFAULT_REGIME_CONFIG): number {
  return Math.max(cfg.slowPeriod, cfg.atrPeriod + 1, cfg.bbPeriod) + 5;
}

export function classifyRegime(bars: readonly Candle[], cfg: RegimeConfig = DEFAULT_REGIME_CONFIG): RegimeResult {
  const empty: RegimeResult['evidence'] = {
    emaFast: null,
    emaSlow: null,
    separationPct: null,
    atr: null,
    atrPct: null,
    bandwidth: null,
    slopePct: null,
  };

  if (bars.length < regimeWarmup(cfg)) {
    return {
      regime: 'uncertain',
      evidence: empty,
      explanation: `Only ${bars.length} closed bars; ${regimeWarmup(cfg)} are required to classify a regime.`,
    };
  }

  const closes = bars.map((b) => b.close);
  const fast = last(ema(closes, cfg.fastPeriod));
  const slow = last(ema(closes, cfg.slowPeriod));
  const atrValue = last(atr(bars, cfg.atrPeriod));
  const band = bollinger(closes, cfg.bbPeriod, 2);
  const bandwidth = last(band.bandwidth);
  const price = closes.at(-1)!;

  // Slope of the slow MA over the last 10 bars: distinguishes a genuine trend
  // from two moving averages that merely happen to be separated.
  const slowSeries = sma(closes, cfg.slowPeriod);
  const slowNow = slowSeries.at(-1) ?? null;
  const slowThen = slowSeries.at(-11) ?? null;
  const slopePct = slowNow !== null && slowThen !== null && slowThen !== 0 ? ((slowNow - slowThen) / slowThen) * 100 : null;

  const separationPct = fast !== null && slow !== null && slow !== 0 ? ((fast - slow) / slow) * 100 : null;
  const atrPct = atrValue !== null && price !== 0 ? atrValue / price : null;

  const evidence = { emaFast: fast, emaSlow: slow, separationPct, atr: atrValue, atrPct, bandwidth, slopePct };

  if (separationPct === null || atrPct === null) {
    return { regime: 'uncertain', evidence, explanation: 'Indicator warm-up incomplete; regime undetermined.' };
  }

  const sepFrac = Math.abs(separationPct) / 100;
  const trending = sepFrac >= cfg.trendSeparation;
  const up = separationPct > 0;
  const slopeAgrees = slopePct === null || (up ? slopePct >= 0 : slopePct <= 0);

  // Volatility extremes are reported in preference to trend labels, because
  // they change position sizing and strategy eligibility more than direction.
  if (atrPct >= cfg.highVolAtrPct) {
    return {
      regime: 'high_volatility',
      evidence,
      explanation: `ATR is ${(atrPct * 100).toFixed(2)}% of price (threshold ${(cfg.highVolAtrPct * 100).toFixed(2)}%). Position sizes shrink and stops widen in this regime.`,
    };
  }
  if (atrPct <= cfg.lowVolAtrPct) {
    return {
      regime: 'low_volatility',
      evidence,
      explanation: `ATR is only ${(atrPct * 100).toFixed(2)}% of price (threshold ${(cfg.lowVolAtrPct * 100).toFixed(2)}%). Breakout setups often fail to follow through here.`,
    };
  }
  if (trending && slopeAgrees) {
    return {
      regime: up ? 'uptrend' : 'downtrend',
      evidence,
      explanation: `EMA${cfg.fastPeriod} is ${separationPct.toFixed(2)}% ${up ? 'above' : 'below'} EMA${cfg.slowPeriod} (threshold ${(cfg.trendSeparation * 100).toFixed(2)}%), and the SMA${cfg.slowPeriod} slope agrees.`,
    };
  }
  if (trending && !slopeAgrees) {
    return {
      regime: 'uncertain',
      evidence,
      explanation: 'Moving averages are separated but the longer-term slope disagrees - the trend is not confirmed.',
    };
  }
  return {
    regime: 'sideways',
    evidence,
    explanation: `EMA separation is only ${separationPct.toFixed(2)}%, below the ${(cfg.trendSeparation * 100).toFixed(2)}% trend threshold.`,
  };
}
