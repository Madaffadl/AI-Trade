import { describe, expect, it } from 'vitest';
import { buildTradePlan, maxEntryPrice, netRiskReward, plannedEntryPrice, type PlanInput } from '@/lib/plan/build';
import { trendContext } from '@/lib/plan/context';
import { buildCostModel } from '@/lib/plan/costs';
import { detectPendingEntry } from '@/lib/plan/pending';
import { rankSetups, scoreSetup } from '@/lib/plan/ranking';
import { floorToStep, sizePosition } from '@/lib/plan/sizing';
import { evaluateState } from '@/lib/plan/states';
import { startOfWibDay } from '@/lib/plan/engine';
import type { TradePlan, TrendContext } from '@/lib/plan/types';
import type { Candle } from '@/lib/market/types';
import type { IndicatorBundle, StrategyOutput } from '@/lib/strategies/types';

/** The deterministic trading-plan engine: every number the user is told to act on. */

const HOUR = 3_600_000;
const costs = buildCostModel({ takerFeePercent: 0.2, spreadPercent: 0.2, sellTaxPercent: 0.21, otherFeePercentPerSide: 0.0111 });
const freeCosts = buildCostModel({ takerFeePercent: 0, spreadPercent: 0, sellTaxPercent: 0, otherFeePercentPerSide: 0 });
const up: TrendContext = { timeframe: '4h', up: true, strength: 0.6, close: 1, emaFast: 1, emaSlow: 1 };

function bars(closes: number[], step = HOUR): Candle[] {
  return closes.map((c, i) => ({
    openTimeMs: i * step, closeTimeMs: (i + 1) * step, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 100, isPartial: false,
  }));
}

describe('higher-timeframe trend filter', () => {
  it('is up only when EMA20 > EMA50 and the close is above EMA50', () => {
    expect(trendContext(bars(Array.from({ length: 120 }, (_, i) => 100 + i)), '4h').up).toBe(true);
    expect(trendContext(bars(Array.from({ length: 120 }, (_, i) => 300 - i)), '4h').up).toBe(false);
  });

  it('treats too little history as "not up", never as up', () => {
    expect(trendContext(bars([1, 2, 3]), '1d')).toMatchObject({ up: false, strength: 0 });
  });
});

describe('position sizing', () => {
  const base = {
    entry: 100, stop: 95, usableCapitalIdr: 1_000_000, cashAvailableIdr: 1_000_000, riskPercent: 1,
    maxAllocationPercent: 50, quantityIncrement: 1e-8, minOrderIdr: 10_000, costs: freeCosts,
  };

  it('sizes from the stop distance when the risk budget binds', () => {
    // Risk Rp10,000 / Rp5 per unit = 2,000 units = Rp200,000 notional (under the 50% cap).
    const s = sizePosition(base);
    expect(s).toMatchObject({ ok: true, limitedBy: 'risk', quantity: 2000, notionalIdr: 200_000, lossAtStopIdr: 10_000 });
  });

  it('caps a tight stop at the allocation limit, and reports the lower real risk', () => {
    const s = sizePosition({ ...base, stop: 99.5 });
    expect(s.limitedBy).toBe('allocation');
    expect(s.notionalIdr).toBeCloseTo(500_000, 0);
    expect(s.effectiveRiskPercent).toBeLessThan(1);
  });

  it('never spends cash that is already committed', () => {
    expect(sizePosition({ ...base, cashAvailableIdr: 50_000 })).toMatchObject({ limitedBy: 'cash', notionalIdr: 50_000 });
  });

  it('includes costs in the loss at the stop', () => {
    expect(sizePosition({ ...base, costs }).lossAtStopIdr).toBeCloseTo(10_000, 0);
    expect(sizePosition({ ...base, costs }).quantity).toBeLessThan(2000);
  });

  it('refuses rather than rounds up below the Rp10,000 minimum order', () => {
    const s = sizePosition({ ...base, usableCapitalIdr: 100_000, cashAvailableIdr: 100_000, maxAllocationPercent: 5 });
    expect(s).toMatchObject({ ok: false, failure: 'below_min_order' });
    expect(sizePosition({ ...base, cashAvailableIdr: 0 }).failure).toBe('no_capital');
  });

  it('rounds quantity DOWN to the exchange step', () => {
    expect(floorToStep(1.23456789123, 1e-8)).toBe(1.23456789);
    expect(floorToStep(113272.9, 1)).toBe(113272);
    expect(floorToStep(0.3, 0.1)).toBe(0.3);
  });
});

function planInput(over: Partial<PlanInput> = {}): PlanInput {
  return {
    assetId: 'a1', symbol: 'TESTIDR', description: 'TEST/IDR',
    strategy: { id: 'trend_follow_ema', version: '1.0.0', name: 'Trend', horizonBars: 20 },
    timeframe: '1h', contextTimeframe: '4h', kind: 'triggered',
    signalBar: { openTimeMs: 0, closeTimeMs: HOUR },
    referenceEntry: 100, plannedEntry: 100, entryLow: 99, stopLoss: 95, takeProfit1: 110, takeProfit2: 120,
    trigger: null, atr: 2, context: up, costs,
    capital: { usableIdr: 1_000_000, cashAvailableIdr: 1_000_000 },
    settings: { riskPercent: 1, maxAllocationPercent: 50, minNetRiskReward: 1.5 },
    pair: { quantityIncrement: 1e-8, minOrderIdr: 10_000 },
    rules: [], risks: [], invalidation: [], summary: '',
    ...over,
  };
}

describe('trade plan', () => {
  it('is eligible when trend, costs, reward:risk and size all work', () => {
    const p = buildTradePlan(planInput());
    expect(p.eligibility).toEqual({ ok: true, failures: [], minNetRiskReward: 1.5 });
    expect(p.outcome.netRiskReward).toBeGreaterThan(1.5);
    expect(p.outcome.netRiskReward).toBeLessThan(p.outcome.grossRiskReward);
    expect(p.holding).toEqual({ horizonBars: 20, horizonMs: 20 * HOUR });
    expect(p.expiresAtMs).toBe(4 * HOUR);
    expect(p.outcome.netProfitTp1Idr).toBeGreaterThan(0);
  });

  it('says exactly why a setup is not a trade', () => {
    expect(buildTradePlan(planInput({ context: { ...up, up: false } })).eligibility.failures).toEqual(['context_down']);
    // TP1 1% away while a round trip costs ~0.83%: costs, not the setup, would decide the result.
    const tight = buildTradePlan(planInput({ stopLoss: 99.5, takeProfit1: 101, takeProfit2: null }));
    expect(tight.eligibility.failures).toEqual(expect.arrayContaining(['rr_too_low', 'target_within_costs']));
  });

  it('puts the maximum entry where net reward:risk meets the minimum, or a quarter ATR up', () => {
    const wide = maxEntryPrice({ referenceEntry: 100, atr: 100, stopLoss: 95, takeProfit1: 110, minNetRiskReward: 1.5, costs })!;
    expect(netRiskReward(wide, 95, 110, costs)).toBeCloseTo(1.5, 4);
    // Wide target: the quarter-ATR chase limit binds first.
    expect(maxEntryPrice({ referenceEntry: 100, atr: 2, stopLoss: 95, takeProfit1: 115, minNetRiskReward: 1.5, costs })).toBe(100.5);
    // 10% target with ~0.83% round-trip costs: net R:R hits 1.5 at ~Rp100.16, before the chase limit.
    const rrBound = maxEntryPrice({ referenceEntry: 100, atr: 2, stopLoss: 95, takeProfit1: 110, minNetRiskReward: 1.5, costs })!;
    expect(rrBound).toBeLessThan(100.5);
    expect(netRiskReward(rrBound, 95, 110, costs)).toBeCloseTo(1.5, 4);
    expect(maxEntryPrice({ referenceEntry: 100, atr: 2, stopLoss: 99.9, takeProfit1: 100.2, minNetRiskReward: 1.5, costs })).toBeNull();
  });

  it('draws a chased setup at the maximum entry, not at the price it ran to', () => {
    expect(plannedEntryPrice(104, 100.5, null)).toBe(100.5);
    expect(plannedEntryPrice(99.8, 100.5, null)).toBe(99.8);
    expect(plannedEntryPrice(104, 100.5, 101)).toBe(101);
  });
});

describe('setup state against the live order book', () => {
  const plan = buildTradePlan(planInput());
  const at = HOUR + 60_000;
  const q = (bid: number, ask: number) => ({ bid, ask, atMs: at });

  it('is BUY NOW only when buyable at or below the maximum entry', () => {
    expect(evaluateState(plan, q(99.9, 100.1), true, at)).toEqual({ state: 'BUY_NOW', reason: 'actionable' });
    expect(evaluateState(plan, q(101, 101.2), true, at)).toEqual({ state: 'WAIT_FOR_ENTRY', reason: 'above_max_entry' });
  });

  it('never shows an action on bad, old or broken data', () => {
    expect(evaluateState(plan, q(99.9, 100.1), false, at).state).toBe('DATA_STALE');
    expect(evaluateState(plan, null, true, at).state).toBe('DATA_STALE');
    expect(evaluateState(plan, { ...q(99.9, 100.1), atMs: at - 11 * 60_000 }, true, at).state).toBe('DATA_STALE');
    expect(evaluateState(plan, q(99.9, 100.1), true, plan.expiresAtMs + 1).state).toBe('EXPIRED');
  });

  it('retires a setup whose stop or target was already reached', () => {
    expect(evaluateState(plan, q(95, 95.2), true, at).state).toBe('INVALIDATED');
    expect(evaluateState(plan, q(110, 110.2), true, at).state).toBe('MISSED');
  });

  it('does not apply the stop to a pending setup that has not been entered yet', () => {
    // Breakout-style: stop 0.2% under the trigger, price still below both - normal before a breakout.
    const pending = buildTradePlan(
      planInput({ kind: 'pending', trigger: { price: 100, requiresVolume: true }, stopLoss: 99.8, takeProfit1: 110, atr: 2 }),
    );
    expect(evaluateState(pending, q(99, 99.2), true, at).state).not.toBe('INVALIDATED');
    // More than 1 ATR under the trigger: the near-breakout no longer exists.
    expect(evaluateState(pending, q(97.5, 97.7), true, at)).toEqual({ state: 'INVALIDATED', reason: 'left_trigger_zone' });
  });

  it('keeps a pending setup waiting for its trigger, and an ineligible one out', () => {
    const pending = buildTradePlan(planInput({ kind: 'pending', trigger: { price: 100, requiresVolume: false } }));
    expect(evaluateState(pending, q(99.9, 100.1), true, at)).toEqual({ state: 'WAIT_FOR_ENTRY', reason: 'awaiting_trigger' });
    const blocked = buildTradePlan(planInput({ context: { ...up, up: false } }));
    expect(evaluateState(blocked, q(99.9, 100.1), true, at).state).toBe('NOT_ELIGIBLE');
  });
});

describe('pending (wait-for-entry) detection', () => {
  const closes = Array.from({ length: 130 }, (_, i) => 100 + i * 0.1);
  const b = bars(closes);
  const ind = { atr: closes.map(() => 1), support: 105 } as unknown as IndicatorBundle;
  const out = (rules: [string, boolean][]): StrategyOutput => ({
    action: 'WAIT', strength: 'insufficient', levels: null, risks: [], invalidation: [], summary: '',
    rules: rules.map(([id, passed]) => ({ id, passed, description: id, detail: '' })),
  });
  const params = { atrMultiplier: 1.5, target1R: 1.5, target2R: 3, channelPeriod: 20 };

  it('turns a trend setup missing only its resumption close into a price trigger', () => {
    const p = detectPendingEntry('trend_follow_ema', out([['T1', true], ['T2', true], ['T3', true], ['T4', false], ['T5', true], ['T6', true]]), b, ind, params);
    const last = b.at(-1)!;
    expect(p).toMatchObject({ triggerPrice: last.high, requiresVolume: false });
    expect(p!.stopLoss).toBeCloseTo(Math.min(last.high - 1.5, 105 * 0.999), 10);
    expect(p!.takeProfit1).toBeCloseTo(last.high + 1.5 * (last.high - p!.stopLoss), 10);
  });

  it('gives nothing when more than the trigger is missing', () => {
    expect(detectPendingEntry('trend_follow_ema', out([['T1', true], ['T2', false], ['T3', true], ['T4', false], ['T5', true], ['T6', true]]), b, ind, params)).toBeNull();
    expect(detectPendingEntry('trend_follow_ema', out([['R0', false]]), b, ind, params)).toBeNull();
  });

  it('turns a near-breakout into a close-above-the-channel trigger that needs volume', () => {
    const rules = out([['B1', false], ['B2', false], ['B3', false], ['B4', true], ['B5', true]]);
    const breakoutParams = { ...params, target1R: 2, target2R: 4 };
    // Close sits ~1.1 below the channel high: within a 2-point ATR, beyond a 1-point one.
    const wideAtr = { ...ind, atr: closes.map(() => 2) } as unknown as IndicatorBundle;
    const p = detectPendingEntry('breakout_donchian', rules, b, wideAtr, breakoutParams);
    const upper = Math.max(...b.slice(-20).map((x) => x.high));
    expect(p).toMatchObject({ requiresVolume: true, triggerPrice: upper });
    expect(p!.stopLoss).toBeCloseTo(upper * 0.998, 10);
    expect(detectPendingEntry('breakout_donchian', rules, b, ind, breakoutParams)).toBeNull();
  });
});

describe('ranking', () => {
  const plan = buildTradePlan(planInput());
  const rank = (state: 'BUY_NOW' | 'WAIT_FOR_ENTRY' | 'NOT_ELIGIBLE', score: number, symbol: string) => ({
    state, score, plan: { ...plan, symbol } as TradePlan,
  });

  it('puts every buyable setup before any that is still waiting, then by score', () => {
    const ordered = rankSetups([rank('WAIT_FOR_ENTRY', 0.9, 'A'), rank('BUY_NOW', 0.4, 'B'), rank('NOT_ELIGIBLE', 1, 'C'), rank('BUY_NOW', 0.6, 'D')]);
    expect(ordered.map((x) => x.plan.symbol)).toEqual(['D', 'B', 'A']);
  });

  it('scores validated strategies above experimental ones, all else equal', () => {
    const args = { plan, state: 'BUY_NOW' as const, volumeIdr: 1e10, spreadPercent: 0.1, maxSpreadPercent: 0.5, ask: 100 };
    expect(scoreSetup({ ...args, validation: 'validated' }).score).toBeGreaterThan(scoreSetup({ ...args, validation: 'experimental' }).score);
  });
});

describe('daily loss window', () => {
  it('resets at midnight in Indonesia (WIB), not at UTC midnight', () => {
    // 2026-10-28 18:00 UTC is 2026-10-29 01:00 WIB -> the day began at 2026-10-28 17:00 UTC.
    expect(new Date(startOfWibDay(Date.UTC(2026, 9, 28, 18))).toISOString()).toBe('2026-10-28T17:00:00.000Z');
  });
});
