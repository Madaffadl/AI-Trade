import { describe, expect, it } from 'vitest';
import {
  backtestPlans,
  netR,
  netReturnPct,
  randomEntryBaseline,
  seededRandom,
  validationVerdict,
} from '@/lib/evaluation/plan-backtest';
import { buildCostModel } from '@/lib/plan/costs';
import { STRATEGIES } from '@/lib/strategies';
import type { Candle } from '@/lib/market/types';

/** Plan-level backtest and the validation gate that decides "validated" vs "experimental". */

const H = 3_600_000;
const breakout = STRATEGIES.find((s) => s.id === 'breakout_donchian')!;
const zero = buildCostModel({ takerFeePercent: 0, spreadPercent: 0, sellTaxPercent: 0, otherFeePercentPerSide: 0 });
const indodax = buildCostModel({ takerFeePercent: 0.2, spreadPercent: 2, sellTaxPercent: 0.21, otherFeePercentPerSide: 0.0111 });

/** A rising, oscillating market with periodic volume spikes: produces breakout signals. */
function series(n: number, step: number, startMs = 0): Candle[] {
  const out: Candle[] = [];
  for (let t = 0; t < n; t++) {
    const c = 100 * Math.exp(0.002 * t) * (1 + 0.03 * Math.sin(t / 6));
    const o = t ? out[t - 1]!.close : c;
    out.push({
      openTimeMs: startMs + t * step,
      closeTimeMs: startMs + (t + 1) * step,
      open: o,
      high: Math.max(o, c) * 1.004,
      low: Math.min(o, c) * 0.996,
      close: c,
      volume: t % 17 === 0 ? 5000 : 1000,
      isPartial: false,
    });
  }
  return out;
}

const bars = series(900, H);
const ctx = series(300, 4 * H);
const run = (over: Partial<Parameters<typeof backtestPlans>[0]> = {}) =>
  backtestPlans({ strategy: breakout, timeframe: '1h', contextTimeframe: '4h', bars, contextBars: ctx, costs: zero, minNetRiskReward: 1, ...over });

describe('Indodax round-trip arithmetic', () => {
  const c = buildCostModel({ takerFeePercent: 0.2, spreadPercent: 0.2, sellTaxPercent: 0.21, otherFeePercentPerSide: 0 });

  it('charges the sale tax on the exit side only', () => {
    // entry cost 0.3% of 100 = 0.3; exit cost 0.51% of 102 = 0.5202; net = 2 - 0.8202 on 100
    expect(netReturnPct(100, 102, c)).toBeCloseTo(1.1798, 10);
  });

  it('expresses the result in units of the planned risk, costs included', () => {
    // risk per unit = 5 + 0.3 + 0.51% x 95 = 5.7845; result per unit = 1.1798
    expect(netR(100, 95, 102, c)).toBeCloseTo(1.1798 / 5.7845, 8);
  });
});

describe('plan-level backtest', () => {
  it('trades signals that pass the live plan rules', () => {
    const r = run();
    expect(r.signals).toBeGreaterThan(0);
    expect(r.trades.length).toBeGreaterThan(0);
    for (const t of r.trades) expect(t.netPct).toBeCloseTo(t.grossPct, 10); // zero costs
  });

  it('rejects what the live engine would reject once real costs apply', () => {
    const free = run();
    const costly = run({ costs: indodax, minNetRiskReward: 1.5 });
    expect(costly.trades.length).toBeLessThan(free.trades.length);
    expect((costly.rejected.target_within_costs ?? 0) + (costly.rejected.rr_too_low ?? 0)).toBeGreaterThan(0);
    for (const t of costly.trades) expect(t.netPct).toBeLessThan(t.grossPct);
  });

  it('never sees the future: changing later candles leaves earlier entries untouched', () => {
    const k = 700;
    const tampered = bars.map((b, i) =>
      i < k ? b : { ...b, open: b.open * 3, high: b.high * 3, low: b.low * 3, close: b.close * 3 },
    );
    const entries = (trades: ReturnType<typeof run>['trades']) =>
      trades.filter((t) => t.entryTimeMs <= bars[k - 1]!.closeTimeMs).map((t) => [t.entryTimeMs, t.entry, t.stopLoss, t.takeProfit1]);
    expect(entries(run().trades).length).toBeGreaterThan(0);
    expect(entries(run({ bars: tampered }).trades)).toEqual(entries(run().trades));
  });

  it('uses only context candles closed by the time of the entry', () => {
    // Every context candle lies in the future of every entry, so no trend is known yet.
    const future = series(300, 4 * H, bars.at(-1)!.closeTimeMs);
    const r = run({ contextBars: future });
    expect(r.trades).toHaveLength(0);
    expect(r.rejected.context_down).toBe(r.signals);
  });
});

describe('random-entry benchmark', () => {
  const args = { bars, fromIndex: 400, count: 50, atrMultiplier: 1.5, targetR: 2, horizonBars: 20, costs: indodax };

  it('is reproducible for a seed and differs across seeds', () => {
    expect(randomEntryBaseline({ ...args, seed: 7 })).toEqual(randomEntryBaseline({ ...args, seed: 7 }));
    expect(randomEntryBaseline({ ...args, seed: 7 })).not.toEqual(randomEntryBaseline({ ...args, seed: 8 }));
    expect(seededRandom(1)()).toBe(seededRandom(1)());
  });

  it('only enters inside the requested period', () => {
    expect(randomEntryBaseline({ ...args, seed: 1, fromIndex: bars.length })).toEqual([]);
  });
});

describe('validation gate', () => {
  const good = { trades: 40, expectancyPct: 0.4, profitFactor: 1.5, randomExpectancyPct: -0.7 };

  it('validates only when every out-of-sample condition holds', () => {
    expect(validationVerdict(good)).toEqual({ label: 'validated', unmet: [] });
  });

  it('names every condition that fails', () => {
    expect(validationVerdict({ ...good, trades: 29 }).unmet).toEqual(['too_few_trades']);
    expect(validationVerdict({ ...good, expectancyPct: -0.1 }).unmet).toEqual(['not_profitable']);
    expect(validationVerdict({ ...good, profitFactor: 1.05 }).unmet).toEqual(['weak_profit_factor']);
    expect(validationVerdict({ ...good, randomExpectancyPct: 0.5 }).unmet).toEqual(['no_better_than_random']);
  });

  it('keeps a strategy with no trades experimental', () => {
    const v = validationVerdict({ trades: 0, expectancyPct: null, profitFactor: null, randomExpectancyPct: -0.7 });
    expect(v.label).toBe('experimental');
    expect(v.unmet).toEqual(expect.arrayContaining(['too_few_trades', 'not_profitable', 'no_better_than_random']));
  });
});
