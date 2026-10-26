import { describe, expect, it } from 'vitest';
import { evaluateSignal } from '@/lib/evaluation/outcomes';
import { buyAndHoldReturnPct, computeMetrics, forecastAccuracy } from '@/lib/evaluation/metrics';
import { runBacktest, walkForwardWindows } from '@/lib/evaluation/backtest';
import { evaluateForecastModels, NAIVE, DRIFT } from '@/lib/forecast/baselines';
import { STRATEGIES } from '@/lib/strategies';
import type { Candle } from '@/lib/market/types';
import { TIMEFRAME_MS } from '@/lib/market/types';

const DAY = TIMEFRAME_MS['1d'];

function bar(i: number, { high, low, close }: { high: number; low: number; close: number }): Candle {
  return {
    openTimeMs: i * DAY,
    closeTimeMs: (i + 1) * DAY,
    open: close,
    high,
    low,
    close,
    volume: 1000,
    isPartial: false,
  };
}

describe('evaluateSignal', () => {
  const common = { entry: 100, stopLoss: 95, takeProfit: 110, horizonBars: 10, feeBps: 0, slippageBps: 0 };

  it('records a target hit when the target is reached first', () => {
    const forward = [bar(1, { high: 105, low: 99, close: 104 }), bar(2, { high: 112, low: 103, close: 111 })];
    const r = evaluateSignal({ ...common, forwardBars: forward });
    expect(r.outcome).toBe('target_hit');
    expect(r.exitPrice).toBe(110);
    expect(r.barsObserved).toBe(2);
  });

  it('records a stop hit when the stop is reached first', () => {
    const forward = [bar(1, { high: 102, low: 94, close: 96 })];
    const r = evaluateSignal({ ...common, forwardBars: forward });
    expect(r.outcome).toBe('stop_hit');
    expect(r.exitPrice).toBe(95);
  });

  it('assumes the STOP first when one bar contains both levels', () => {
    // This bar spans 93..115: both the stop (95) and the target (110) are inside.
    const forward = [bar(1, { high: 115, low: 93, close: 112 })];
    const r = evaluateSignal({ ...common, forwardBars: forward });
    expect(r.outcome).toBe('stop_hit');
    expect(r.exitReason).toMatch(/pessimistic/i);
  });

  it('does NOT count a brief favourable excursion as a win', () => {
    // Price reaches 109 (below the 110 target) then closes the horizon lower.
    const forward = Array.from({ length: 10 }, (_, i) =>
      bar(i + 1, i === 0 ? { high: 109, low: 99, close: 108 } : { high: 99, low: 97, close: 98 }),
    );
    const r = evaluateSignal({ ...common, forwardBars: forward });
    expect(r.outcome).toBe('timeout_loss');
    expect(r.returnPct!).toBeLessThan(0);
    // The excursion is kept as a diagnostic, not as the outcome.
    expect(r.maxFavorableExcursion!).toBeGreaterThan(0);
  });

  it('stays pending until the horizon has elapsed', () => {
    const forward = [bar(1, { high: 101, low: 99, close: 100 })];
    const r = evaluateSignal({ ...common, forwardBars: forward });
    expect(r.outcome).toBe('pending');
    expect(r.incomplete).toBe(true);
    expect(r.returnPct).toBeNull();
  });

  it('is unevaluable without a stop or a target', () => {
    expect(evaluateSignal({ ...common, stopLoss: null, forwardBars: [] }).outcome).toBe('unevaluable');
    expect(evaluateSignal({ ...common, takeProfit: null, forwardBars: [] }).outcome).toBe('unevaluable');
  });

  it('charges costs on both entry and exit', () => {
    const forward = [bar(1, { high: 112, low: 103, close: 111 })];
    const free = evaluateSignal({ ...common, forwardBars: forward });
    const costly = evaluateSignal({ ...common, forwardBars: forward, feeBps: 10, slippageBps: 5 });
    expect(costly.returnPctNet!).toBeLessThan(free.returnPctNet!);
    expect(free.returnPctNet! - costly.returnPctNet!).toBeCloseTo(0.3, 6); // 15bps * 2 = 0.30%
  });
});

describe('computeMetrics', () => {
  const trade = (returnPctNet: number, overlapsPrior = false, i = 0) => ({
    returnPctNet,
    rMultiple: returnPctNet / 5,
    outcome: returnPctNet > 0 ? 'target_hit' : 'stop_hit',
    generatedAtMs: i * DAY,
    overlapsPrior,
  });

  it('refuses to make a claim with no trades', () => {
    const m = computeMetrics([]);
    expect(m.trades).toBe(0);
    expect(m.winRatePct).toBeNull();
    expect(m.sampleWarning).toMatch(/no performance claim/i);
  });

  it('excludes overlapping trades from the independent sample by default', () => {
    const trades = [trade(5, false, 0), trade(-3, true, 1), trade(4, false, 2)];
    const independent = computeMetrics(trades);
    const all = computeMetrics(trades, true);
    expect(independent.trades).toBe(2);
    expect(independent.overlappingExcluded).toBe(1);
    expect(all.trades).toBe(3);
  });

  it('computes win rate, expectancy and profit factor', () => {
    const m = computeMetrics([trade(10, false, 0), trade(-5, false, 1), trade(10, false, 2), trade(-5, false, 3)]);
    expect(m.winRatePct).toBeCloseTo(50, 10);
    expect(m.expectancyPct).toBeCloseTo(2.5, 10);
    expect(m.profitFactor).toBeCloseTo(2, 10); // 20 / 10
  });

  it('reports profit factor as undefined rather than Infinity when there are no losses', () => {
    expect(computeMetrics([trade(5, false, 0), trade(3, false, 1)]).profitFactor).toBeNull();
  });

  it('tracks max drawdown across the chronological sequence', () => {
    const m = computeMetrics([trade(10, false, 0), trade(-15, false, 1), trade(2, false, 2)]);
    expect(m.maxDrawdownPct).toBeCloseTo(15, 10);
  });

  it('warns loudly about small samples', () => {
    expect(computeMetrics([trade(5, false, 0)]).sampleWarning).toMatch(/at least 30/i);
  });

  it('computes a buy-and-hold benchmark', () => {
    expect(buyAndHoldReturnPct(100, 120)).toBeCloseTo(20, 10);
    expect(buyAndHoldReturnPct(0, 120)).toBeNull();
  });
});

describe('forecastAccuracy', () => {
  it('computes MAE, RMSE and directional accuracy', () => {
    const preds = [
      { predicted: 101, actual: 102, previous: 100 }, // up / up -> correct
      { predicted: 99, actual: 103, previous: 100 }, // down / up -> wrong
    ];
    const a = forecastAccuracy(preds);
    expect(a.observations).toBe(2);
    expect(a.mae).toBeCloseTo((1 + 4) / 2, 10);
    expect(a.rmse).toBeCloseTo(Math.sqrt((1 + 16) / 2), 10);
    expect(a.directionalAccuracyPct).toBeCloseTo(50, 10);
  });
});

describe('backtest no-lookahead contract', () => {
  /**
   * The decisive test: corrupting bars AFTER the point a signal was generated
   * must not change that signal. If the strategy could see the future, the
   * trade list would differ.
   */
  it('signals do not change when future bars are altered', () => {
    const prices = Array.from({ length: 300 }, (_, i) => 100 + i * 0.3 + Math.sin(i / 6) * 4);
    const bars: Candle[] = prices.map((p, i) => ({
      openTimeMs: i * DAY,
      closeTimeMs: (i + 1) * DAY,
      open: p * 0.998,
      high: p * 1.012,
      low: p * 0.988,
      close: p,
      volume: 1000 + (i % 7) * 400,
      isPartial: false,
    }));

    const strategy = STRATEGIES.find((s) => s.id === 'trend_follow_ema')!;
    const original = runBacktest({ strategy, bars, timeframe: '1d', assetClass: 'crypto' });

    // Multiply the last 50 bars by 3 - a change no honest strategy could know
    // about when generating earlier signals.
    const tampered = bars.map((b, i) =>
      i >= bars.length - 50 ? { ...b, open: b.open * 3, high: b.high * 3, low: b.low * 3, close: b.close * 3 } : b,
    );
    const after = runBacktest({ strategy, bars: tampered, timeframe: '1d', assetClass: 'crypto' });

    const entryTimesBefore = original.trades.filter((t) => t.index < bars.length - 50).map((t) => t.entryTimeMs);
    const entryTimesAfter = after.trades.filter((t) => t.index < bars.length - 50).map((t) => t.entryTimeMs);
    expect(entryTimesAfter).toEqual(entryTimesBefore);
  });

  it('always reports its simulation assumptions', () => {
    const bars: Candle[] = Array.from({ length: 300 }, (_, i) => {
      const p = 100 + i * 0.3;
      return {
        openTimeMs: i * DAY,
        closeTimeMs: (i + 1) * DAY,
        open: p,
        high: p * 1.01,
        low: p * 0.99,
        close: p,
        volume: 1000,
        isPartial: false,
      };
    });
    const r = runBacktest({ strategy: STRATEGIES[0]!, bars, timeframe: '1d', assetClass: 'crypto' });
    expect(r.warnings.join(' ')).toMatch(/no partial fills/i);
    expect(r.benchmarkBuyHoldPct).not.toBeNull();
  });

  it('refuses to backtest without enough history', () => {
    const bars: Candle[] = Array.from({ length: 50 }, (_, i) => bar(i, { high: 101, low: 99, close: 100 }));
    const r = runBacktest({ strategy: STRATEGIES[0]!, bars, timeframe: '1d', assetClass: 'crypto' });
    expect(r.trades).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/not enough history/i);
  });

  it('produces chronological, non-overlapping walk-forward windows', () => {
    const windows = walkForwardWindows(100, 40, 20);
    expect(windows[0]).toEqual({ start: 0, end: 40 });
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.start).toBeGreaterThan(windows[i - 1]!.start);
    }
  });
});

describe('forecast baselines', () => {
  it('the naive model predicts the last close exactly', () => {
    expect(NAIVE.predict([10, 20, 30])).toBe(30);
  });

  it('the drift model extends the average per-bar change', () => {
    // 0..100 over 101 points -> drift of 1 per bar -> predicts 101.
    expect(DRIFT.predict(Array.from({ length: 101 }, (_, i) => i))).toBeCloseTo(101, 10);
  });

  it('evaluates every model against the naive baseline out-of-sample', () => {
    const bars: Candle[] = Array.from({ length: 200 }, (_, i) => {
      const p = 100 + Math.sin(i / 9) * 10;
      return {
        openTimeMs: i * DAY,
        closeTimeMs: (i + 1) * DAY,
        open: p,
        high: p * 1.01,
        low: p * 0.99,
        close: p,
        volume: 100,
        isPartial: false,
      };
    });
    const results = evaluateForecastModels(bars, 50);
    const naive = results.find((r) => r.modelId === 'naive')!;
    expect(naive.rmseVsNaive).toBeCloseTo(1, 10);
    expect(naive.verdict).toMatch(/baseline/i);
    for (const r of results) {
      expect(r.accuracy.observations).toBeGreaterThan(0);
      expect(r.verdict.length).toBeGreaterThan(10);
    }
  });
});
