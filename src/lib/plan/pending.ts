import { at } from '@/lib/indicators';
import type { Candle } from '@/lib/market/types';
import type { IndicatorBundle, StrategyOutput } from '@/lib/strategies/types';

/**
 * "Wait for entry" setups: everything a strategy requires is already true
 * except the final trigger, and the trigger is a plain price level, so the
 * user can be told exactly what to wait for.
 *
 *   trend_follow_ema   T1,T2,T3,T5,T6 pass, only T4 (close above the previous
 *                      bar's high) fails  ->  trigger: next close above this
 *                      bar's high.
 *   trend_momentum     M1,M2,M4,M5 pass, only M3 (new 10-bar closing high)
 *                      fails  ->  trigger: next close above the highest close
 *                      of the last 10 bars.
 *   breakout_donchian  regime, volume data, B4 (close above EMA50) and B5
 *                      (ATR band) pass, only the breakout itself is missing,
 *                      and price is within 1 ATR of it  ->  trigger: next
 *                      close above the 20-bar high, on >= 1.5x volume.
 *
 * Levels are computed with the strategy's own formulas at the trigger price,
 * so a pending plan matches what the strategy will produce if it fires. Rule
 * ids are read from the strategy output; if a strategy renames them this
 * returns null (no pending setup) rather than guessing.
 */

export interface PendingEntry {
  triggerPrice: number;
  entryLow: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  requiresVolume: boolean;
}

type Params = Record<string, number>;

const passed = (out: StrategyOutput, id: string): boolean | null => {
  const r = out.rules.find((x) => x.id === id);
  return r ? r.passed : null;
};

export function detectPendingEntry(
  strategyId: string,
  output: StrategyOutput,
  bars: readonly Candle[],
  ind: IndicatorBundle,
  params: Params,
): PendingEntry | null {
  if (output.action !== 'WAIT') return null;
  const i = bars.length - 1;
  const bar = bars[i];
  const atr = at(ind.atr, i);
  if (!bar || atr === null || atr <= 0) return null;

  if (strategyId === 'trend_follow_ema') {
    const ready = ['T1', 'T2', 'T3', 'T5', 'T6'].every((id) => passed(output, id) === true);
    if (!ready || passed(output, 'T4') !== false) return null;
    const trigger = bar.high;
    const atrStop = trigger - (params.atrMultiplier ?? 1.5) * atr;
    const stop = ind.support !== null && ind.support < trigger ? Math.min(atrStop, ind.support * 0.999) : atrStop;
    const r = trigger - stop;
    if (r <= 0) return null;
    return {
      triggerPrice: trigger,
      entryLow: trigger,
      stopLoss: stop,
      takeProfit1: trigger + (params.target1R ?? 1.5) * r,
      takeProfit2: trigger + (params.target2R ?? 3) * r,
      requiresVolume: false,
    };
  }

  if (strategyId === 'breakout_donchian') {
    if (passed(output, 'B1') !== false || passed(output, 'B4') !== true || passed(output, 'B5') !== true) return null;
    const period = params.channelPeriod ?? 20;
    if (bars.length < period) return null;
    // The next bar's channel high includes this bar.
    const nextUpper = Math.max(...bars.slice(-period).map((b) => b.high));
    if (bar.close < nextUpper - atr) return null;
    const stop = Math.max(nextUpper - (params.atrMultiplier ?? 1.5) * atr, nextUpper * 0.998);
    const r = nextUpper - stop;
    if (r <= 0) return null;
    return {
      triggerPrice: nextUpper,
      entryLow: nextUpper,
      stopLoss: stop,
      takeProfit1: nextUpper + (params.target1R ?? 2) * r,
      takeProfit2: nextUpper + (params.target2R ?? 4) * r,
      requiresVolume: true,
    };
  }

  if (strategyId === 'trend_momentum') {
    const ready = ['M1', 'M2', 'M4', 'M5'].every((id) => passed(output, id) === true);
    const lookback = params.breakoutLookback ?? 10;
    if (!ready || passed(output, 'M3') !== false || bars.length < lookback) return null;
    // The next bar must close above the highest close of the 10 bars before it, this one included.
    const trigger = Math.max(...bars.slice(-lookback).map((b) => b.close));
    const stop = trigger - (params.atrMultiplier ?? 2.5) * atr;
    const r = trigger - stop;
    if (r <= 0) return null;
    return {
      triggerPrice: trigger,
      entryLow: trigger,
      stopLoss: stop,
      takeProfit1: trigger + (params.target1R ?? 2) * r,
      takeProfit2: trigger + (params.target2R ?? 4) * r,
      requiresVolume: false,
    };
  }

  return null;
}
