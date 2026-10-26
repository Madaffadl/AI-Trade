import { bollinger, atr, donchian, ema, macd, rsi, swingLevels, volumeAnalysis } from '@/lib/indicators';
import type { Candle } from '@/lib/market/types';
import { BreakoutStrategy } from './breakout';
import { MeanReversionStrategy } from './mean-reversion';
import { TrendFollowStrategy } from './trend-follow';
import type { IndicatorBundle, Strategy } from './types';

export const STRATEGIES: Strategy[] = [
  new TrendFollowStrategy(),
  new BreakoutStrategy(),
  new MeanReversionStrategy(),
];

export function getStrategy(id: string): Strategy | undefined {
  return STRATEGIES.find((s) => s.id === id);
}

/**
 * Compute every indicator once per (asset, timeframe) and share the bundle
 * across strategies. Recomputing per strategy would be wasted work and risks
 * two strategies disagreeing about the same bar.
 */
export function buildIndicators(bars: readonly Candle[]): IndicatorBundle {
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const m = macd(closes, 12, 26, 9);
  const d = donchian(bars, 20);
  const swings = swingLevels(bars, 5, closes.at(-1));

  return {
    closes,
    emaFast: ema(closes, 20),
    emaSlow: ema(closes, 50),
    emaLong: ema(closes, 200),
    rsi: rsi(closes, 14),
    macdLine: m.macd,
    macdSignal: m.signal,
    macdHistogram: m.histogram,
    atr: atr(bars, 14),
    bollinger: bollinger(closes, 20, 2),
    volume: volumeAnalysis(volumes, 20),
    donchianUpper: d.upper,
    donchianLower: d.lower,
    support: swings.support,
    resistance: swings.resistance,
  };
}

export { BreakoutStrategy, MeanReversionStrategy, TrendFollowStrategy };
export * from './types';
