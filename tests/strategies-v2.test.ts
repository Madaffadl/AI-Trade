import { describe, expect, it } from 'vitest';
import { at } from '@/lib/indicators';
import { detectPendingEntry } from '@/lib/plan/pending';
import { classifyRegime } from '@/lib/signals/regime';
import { buildIndicators, STRATEGIES } from '@/lib/strategies';
import type { Candle } from '@/lib/market/types';
import type { StrategyOutput } from '@/lib/strategies/types';

/** The Indodax-cost-aware strategy set: trend pullback v2 and trend momentum. */

const H4 = 4 * 3_600_000;
const momentum = STRATEGIES.find((s) => s.id === 'trend_momentum')!;
const trend = STRATEGIES.find((s) => s.id === 'trend_follow_ema')!;

/** A rising market that pauses and resumes, so fresh highs and pullbacks both occur. */
function uptrend(n: number): Candle[] {
  const out: Candle[] = [];
  for (let t = 0; t < n; t++) {
    const c = 100 * Math.exp(0.002 * t) * (1 + 0.015 * Math.sin(t / 3));
    const o = t ? out[t - 1]!.close : c;
    out.push({ openTimeMs: t * H4, closeTimeMs: (t + 1) * H4, open: o, high: Math.max(o, c) * 1.006, low: Math.min(o, c) * 0.994, close: c, volume: 1000 + (t % 7) * 200, isPartial: false });
  }
  return out;
}

function evaluateAt(bars: Candle[], t: number) {
  const visible = bars.slice(Math.max(0, t + 1 - 300), t + 1);
  const indicators = buildIndicators(visible);
  return {
    visible,
    indicators,
    out: momentum.evaluate({
      bars: visible, indicators, regime: classifyRegime(visible).regime, timeframe: '4h', assetClass: 'crypto',
      hasOpenPosition: false, openEntryPrice: null, openStopLoss: null, openTarget: null,
    }),
  };
}

describe('trend momentum', () => {
  const bars = uptrend(420);

  it('runs on 4h only, after a 220-bar warm-up', () => {
    expect(momentum.timeframes).toEqual(['4h']);
    expect(evaluateAt(bars, 150).out.summary).toMatch(/Insufficient history/);
  });

  it('buys a fresh closing high with a 2.5 ATR stop and 2R / 4R targets', () => {
    const buys = [];
    for (let t = 230; t < bars.length; t++) {
      const r = evaluateAt(bars, t);
      if (r.out.action === 'BUY') buys.push(r);
    }
    expect(buys.length).toBeGreaterThan(0);
    for (const { visible, indicators, out } of buys) {
      const i = visible.length - 1;
      const entry = visible[i]!.close;
      const atr = at(indicators.atr, i)!;
      expect(out.levels!.stopLoss).toBeCloseTo(entry - 2.5 * atr, 8);
      const r = entry - out.levels!.stopLoss;
      expect(out.levels!.takeProfit1).toBeCloseTo(entry + 2 * r, 8);
      expect(out.levels!.takeProfit2).toBeCloseTo(entry + 4 * r, 8);
      expect(entry).toBeGreaterThan(Math.max(...visible.slice(i - 10, i).map((b) => b.close)));
    }
  });

  it('waits for the closing high when everything else is in place', () => {
    const b = uptrend(240);
    const ind = { atr: b.map(() => 2) } as unknown as Parameters<typeof detectPendingEntry>[3];
    const output: StrategyOutput = {
      action: 'WAIT', strength: 'insufficient', levels: null, risks: [], invalidation: [], summary: '',
      rules: [['M1', true], ['M2', true], ['M3', false], ['M4', true], ['M5', true]].map(([id, passed]) => ({
        id: id as string, passed: passed as boolean, description: '', detail: '',
      })),
    };
    const p = detectPendingEntry('trend_momentum', output, b, ind, momentum.parameters);
    const trigger = Math.max(...b.slice(-10).map((x) => x.close));
    expect(p).toMatchObject({ triggerPrice: trigger, stopLoss: trigger - 5, takeProfit1: trigger + 10, requiresVolume: false });
  });
});

describe('trend pullback v2', () => {
  it('targets 2R / 4R, so its first target can clear a 1.5 net reward:risk after costs', () => {
    expect(trend.version).toBe('2.0.0');
    expect(trend.parameters).toMatchObject({ target1R: 2, target2R: 4 });
  });
});
