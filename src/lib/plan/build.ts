import { TIMEFRAME_MS } from '@/lib/market/types';
import type { RuleOutcome } from '@/lib/strategies/types';
import { costPerUnit, netPnl, roundTripCostPercent, type CostModel } from './costs';
import { sizePosition } from './sizing';
import {
  ENTRY_WINDOW_BARS,
  PLAN_ENGINE_VERSION,
  type ContextTimeframe,
  type EligibilityFailure,
  type EntryTimeframe,
  type SetupKind,
  type TradePlan,
  type TrendContext,
} from './types';

/**
 * Turn a strategy setup into a complete, followable plan.
 *
 * Pure: every input is passed in, so a stored plan can be reproduced exactly.
 *
 * Eligibility (all must hold for the plan to be offered as a trade):
 *   - the higher-timeframe trend is up;
 *   - reward:risk to TP1 AFTER all costs reaches the user's minimum;
 *   - TP1 sits at least 3x the round-trip cost away (otherwise noise and
 *     costs, not the setup, decide the result);
 *   - a position can be sized within capital, cash and the minimum order.
 */

export interface PlanInput {
  assetId: string;
  symbol: string;
  description: string;
  strategy: { id: string; version: string; name: string; horizonBars: number };
  timeframe: EntryTimeframe;
  contextTimeframe: ContextTimeframe;
  kind: SetupKind;
  signalBar: { openTimeMs: number; closeTimeMs: number };
  /** Signal close (triggered) or trigger price (pending). */
  referenceEntry: number;
  /** The price the numbers are computed at: the live ask for a triggered setup, the trigger for a pending one. */
  plannedEntry: number;
  entryLow: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number | null;
  trigger: { price: number; requiresVolume: boolean } | null;
  atr: number;
  context: TrendContext;
  costs: CostModel;
  capital: { usableIdr: number; cashAvailableIdr: number };
  settings: { riskPercent: number; maxAllocationPercent: number; minNetRiskReward: number };
  pair: { quantityIncrement: number | null; minOrderIdr: number | null };
  rules: RuleOutcome[];
  risks: string[];
  invalidation: string[];
  summary: string;
}

/** Reward:risk to `target` after fees, tax and spread on both legs. */
export function netRiskReward(entry: number, stop: number, target: number, costs: CostModel): number {
  const reward = target - entry - costPerUnit(entry, target, costs).total;
  const risk = entry - stop + costPerUnit(entry, stop, costs).total;
  return risk > 0 ? reward / risk : -Infinity;
}

/**
 * Highest entry price at which the net reward:risk still reaches `minRr`.
 * Net R:R falls as entry rises (less reward, more risk), so bisection works.
 * Returns null when even an entry just above the stop does not qualify.
 */
export function maxEntryForRiskReward(stop: number, target: number, minRr: number, costs: CostModel): number | null {
  let lo = stop + (target - stop) * 1e-6;
  let hi = target;
  if (netRiskReward(lo, stop, target, costs) < minRr) return null;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (netRiskReward(mid, stop, target, costs) >= minRr) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * The highest price still worth paying: never more than a quarter ATR above
 * the reference (no chasing), and never past the price where reward:risk
 * after costs stops qualifying. Null when no entry above the stop qualifies.
 */
export function maxEntryPrice(i: {
  referenceEntry: number;
  atr: number;
  stopLoss: number;
  takeProfit1: number;
  minNetRiskReward: number;
  costs: CostModel;
}): number | null {
  const rrBound = maxEntryForRiskReward(i.stopLoss, i.takeProfit1, i.minNetRiskReward, i.costs);
  return rrBound === null ? null : Math.min(i.referenceEntry + 0.25 * i.atr, rrBound);
}

/**
 * Price a plan is computed at. A pending setup buys at its trigger. A
 * triggered one buys at the live ask - but if the ask is already above the
 * maximum entry, the plan is drawn at the maximum entry: that is the price
 * the user is told to wait for, not the one they would chase at.
 */
export function plannedEntryPrice(ask: number, maxEntry: number | null, triggerPrice: number | null): number {
  if (triggerPrice !== null) return triggerPrice;
  return maxEntry === null ? ask : Math.min(ask, maxEntry);
}

export function buildTradePlan(input: PlanInput): TradePlan {
  const { costs } = input;
  const entry = input.plannedEntry;
  const roundTrip = roundTripCostPercent(costs);
  const maxEntry =
    maxEntryPrice({
      referenceEntry: input.referenceEntry,
      atr: input.atr,
      stopLoss: input.stopLoss,
      takeProfit1: input.takeProfit1,
      minNetRiskReward: input.settings.minNetRiskReward,
      costs,
    }) ?? input.stopLoss;

  const sizing = sizePosition({
    entry,
    stop: input.stopLoss,
    usableCapitalIdr: input.capital.usableIdr,
    cashAvailableIdr: input.capital.cashAvailableIdr,
    riskPercent: input.settings.riskPercent,
    maxAllocationPercent: input.settings.maxAllocationPercent,
    quantityIncrement: input.pair.quantityIncrement,
    minOrderIdr: input.pair.minOrderIdr,
    costs,
  });

  const netRr = netRiskReward(entry, input.stopLoss, input.takeProfit1, costs);
  const tp1DistancePercent = ((input.takeProfit1 - entry) / entry) * 100;

  const failures: EligibilityFailure[] = [];
  if (!input.context.up) failures.push('context_down');
  if (!(netRr >= input.settings.minNetRiskReward)) failures.push('rr_too_low');
  if (tp1DistancePercent < 3 * roundTrip) failures.push('target_within_costs');
  if (sizing.failure) failures.push(sizing.failure);

  const step = TIMEFRAME_MS[input.timeframe];
  return {
    engineVersion: PLAN_ENGINE_VERSION,
    assetId: input.assetId,
    symbol: input.symbol,
    description: input.description,
    strategyId: input.strategy.id,
    strategyVersion: input.strategy.version,
    strategyName: input.strategy.name,
    timeframe: input.timeframe,
    contextTimeframe: input.contextTimeframe,
    kind: input.kind,
    signalBarOpenMs: input.signalBar.openTimeMs,
    signalBarCloseMs: input.signalBar.closeTimeMs,
    trigger: input.trigger,
    entry: { planned: entry, low: input.entryLow, max: maxEntry },
    stopLoss: input.stopLoss,
    takeProfit1: input.takeProfit1,
    takeProfit2: input.takeProfit2,
    costs: { ...costs, roundTripPercent: roundTrip },
    sizing,
    outcome: {
      netRiskReward: netRr,
      grossRiskReward: (input.takeProfit1 - entry) / (entry - input.stopLoss),
      stopDistancePercent: ((entry - input.stopLoss) / entry) * 100,
      tp1DistancePercent,
      netProfitTp1Idr: netPnl(entry, input.takeProfit1, sizing.quantity, costs),
      netProfitTp2Idr: input.takeProfit2 === null ? null : netPnl(entry, input.takeProfit2, sizing.quantity, costs),
    },
    holding: { horizonBars: input.strategy.horizonBars, horizonMs: input.strategy.horizonBars * step },
    expiresAtMs: input.signalBar.closeTimeMs + ENTRY_WINDOW_BARS * step,
    atr: input.atr,
    context: input.context,
    eligibility: { ok: failures.length === 0, failures, minNetRiskReward: input.settings.minNetRiskReward },
    rules: input.rules,
    risks: input.risks,
    invalidation: input.invalidation,
    summary: input.summary,
  };
}
