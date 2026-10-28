import { ema, last } from '@/lib/indicators';
import type { Candle } from '@/lib/market/types';
import type { ContextTimeframe, TrendContext } from './types';

/**
 * Higher-timeframe trend filter.
 *
 * An entry on the 1h chart is only allowed when the 4h trend is up, and a 4h
 * entry only when the daily trend is up: a long trade against the larger
 * trend is the classic way a "good-looking" short-term setup fails. "Up"
 * means EMA20 above EMA50 AND the last close above EMA50 - the same
 * definition the trend strategy uses, applied one timeframe higher.
 *
 * Fewer than 60 closed bars means the trend is unknown, and unknown is
 * treated as NOT up.
 */
export function trendContext(closedBars: readonly Candle[], timeframe: ContextTimeframe): TrendContext {
  const closes = closedBars.map((b) => b.close);
  const close = closes.at(-1) ?? null;
  if (closes.length < 60 || close === null) {
    return { timeframe, up: false, strength: 0, close, emaFast: null, emaSlow: null };
  }
  const emaFast = last(ema(closes, 20));
  const emaSlow = last(ema(closes, 50));
  const up = emaFast !== null && emaSlow !== null && emaFast > emaSlow && close > emaSlow;
  const separation = up ? (emaFast! - emaSlow!) / emaSlow! : 0;
  return { timeframe, up, strength: Math.min(1, Math.max(0, separation / 0.05)), close, emaFast, emaSlow };
}
