import { atr } from '@/lib/indicators';
import type { Candle } from '@/lib/market/types';
import { buildTradePlan } from '@/lib/plan/build';
import { trendContext } from '@/lib/plan/context';
import { costPerUnit, type CostModel } from '@/lib/plan/costs';
import type { ContextTimeframe, EligibilityFailure, EntryTimeframe } from '@/lib/plan/types';
import { classifyRegime } from '@/lib/signals/regime';
import { buildIndicators } from '@/lib/strategies';
import type { Strategy } from '@/lib/strategies/types';
import { evaluateSignal } from './outcomes';

/**
 * Backtest of the PLANS the app would have shown - not of raw strategy
 * signals. At every closed bar it does exactly what the live engine does:
 *
 *   - the strategy sees only the last `window` (300) closed bars, as the live
 *     engine fetches 300 - so indicators match what was shown, and nothing
 *     after the bar is visible (no lookahead);
 *   - the higher-timeframe trend uses only context candles CLOSED by then;
 *   - the plan goes through `buildTradePlan`, so the eligibility rules (trend,
 *     net reward:risk, target vs costs) are the live ones, not a copy.
 *
 * An eligible entry is taken at the signal close; the exit is resolved by
 * `evaluateSignal` (stop first when a candle holds both), and the result is
 * charged Indodax's asymmetric costs: fee + levies + half spread on entry,
 * fee + sale tax + levies + half spread on exit. One trade at a time per
 * strategy x pair x timeframe: a new entry waits for the previous exit.
 */

export interface PlanBacktestInput {
  strategy: Strategy;
  timeframe: EntryTimeframe;
  contextTimeframe: ContextTimeframe;
  /** Closed entry-timeframe candles, chronological. */
  bars: readonly Candle[];
  /** Closed context-timeframe candles, chronological. */
  contextBars: readonly Candle[];
  costs: CostModel;
  minNetRiskReward: number;
  window?: number;
}

export interface PlanBacktestTrade {
  entryTimeMs: number;
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  exitPrice: number;
  exitReason: string;
  barsHeld: number;
  grossPct: number;
  netPct: number;
  /** Net result in units of the planned risk (price distance to stop plus costs). */
  rMultiple: number;
  outcome: string;
}

export interface PlanBacktestResult {
  /** Strategy BUY signals seen, before the plan's eligibility rules. */
  signals: number;
  /** How often each eligibility rule rejected a signal (one signal can fail several). */
  rejected: Partial<Record<EligibilityFailure, number>>;
  trades: PlanBacktestTrade[];
}

/** Net result of one long trade, in % of the entry price, after Indodax's costs. */
export function netReturnPct(entry: number, exit: number, costs: CostModel): number {
  return ((exit - entry - costPerUnit(entry, exit, costs).total) / entry) * 100;
}

export function netR(entry: number, stop: number, exit: number, costs: CostModel): number {
  const risk = entry - stop + costPerUnit(entry, stop, costs).total;
  return risk > 0 ? (exit - entry - costPerUnit(entry, exit, costs).total) / risk : 0;
}

export function backtestPlans(i: PlanBacktestInput): PlanBacktestResult {
  const window = i.window ?? 300;
  const { bars, strategy } = i;
  const trades: PlanBacktestTrade[] = [];
  const rejected: PlanBacktestResult['rejected'] = {};
  let signals = 0;
  let openUntil = -1;
  let ctxEnd = 0; // context candles [0, ctxEnd) are closed at the current bar

  for (let t = strategy.warmupBars - 1; t < bars.length - 1; t++) {
    const bar = bars[t]!;
    while (ctxEnd < i.contextBars.length && i.contextBars[ctxEnd]!.closeTimeMs <= bar.closeTimeMs) ctxEnd++;
    if (t <= openUntil) continue;

    const visible = bars.slice(Math.max(0, t + 1 - window), t + 1) as Candle[];
    if (visible.length < strategy.warmupBars) continue;
    const indicators = buildIndicators(visible);
    const output = strategy.evaluate({
      bars: visible,
      indicators,
      regime: classifyRegime(visible).regime,
      timeframe: i.timeframe,
      assetClass: 'crypto',
      hasOpenPosition: false,
      openEntryPrice: null,
      openStopLoss: null,
      openTarget: null,
    });
    if (output.action !== 'BUY' || !output.levels) continue;
    signals++;

    const atrNow = indicators.atr[visible.length - 1] ?? null;
    const context = trendContext(i.contextBars.slice(Math.max(0, ctxEnd - window), ctxEnd), i.contextTimeframe);
    const plan = buildTradePlan({
      assetId: 'backtest',
      symbol: 'backtest',
      description: '',
      strategy: { id: strategy.id, version: strategy.version, name: strategy.name, horizonBars: strategy.evaluationHorizonBars },
      timeframe: i.timeframe,
      contextTimeframe: i.contextTimeframe,
      kind: 'triggered',
      signalBar: { openTimeMs: bar.openTimeMs, closeTimeMs: bar.closeTimeMs },
      referenceEntry: bar.close,
      plannedEntry: bar.close,
      entryLow: output.levels.entryLow,
      stopLoss: output.levels.stopLoss,
      takeProfit1: output.levels.takeProfit1,
      takeProfit2: output.levels.takeProfit2,
      trigger: null,
      atr: atrNow ?? 0,
      context,
      costs: i.costs,
      // Sizing is not what is being tested; returns are in % of the entry.
      capital: { usableIdr: 1e15, cashAvailableIdr: 1e15 },
      settings: { riskPercent: 1, maxAllocationPercent: 100, minNetRiskReward: i.minNetRiskReward },
      pair: { quantityIncrement: null, minOrderIdr: null },
      rules: [],
      risks: [],
      invalidation: [],
      summary: '',
    });
    if (!plan.eligibility.ok) {
      for (const f of plan.eligibility.failures) rejected[f] = (rejected[f] ?? 0) + 1;
      continue;
    }

    const ev = evaluateSignal({
      entry: bar.close,
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit1,
      forwardBars: bars.slice(t + 1),
      horizonBars: strategy.evaluationHorizonBars,
      feeBps: 0,
      slippageBps: 0,
    });
    if (ev.exitPrice === null || ev.outcome === 'pending' || ev.outcome === 'unevaluable') continue;

    trades.push({
      entryTimeMs: bar.closeTimeMs,
      entry: bar.close,
      stopLoss: plan.stopLoss,
      takeProfit1: plan.takeProfit1,
      exitPrice: ev.exitPrice,
      exitReason: ev.exitReason ?? ev.outcome,
      barsHeld: ev.barsObserved,
      grossPct: ((ev.exitPrice - bar.close) / bar.close) * 100,
      netPct: netReturnPct(bar.close, ev.exitPrice, i.costs),
      rMultiple: netR(bar.close, plan.stopLoss, ev.exitPrice, i.costs),
      outcome: ev.outcome,
    });
    openUntil = t + ev.barsObserved;
  }
  return { signals, rejected, trades };
}

/** Deterministic PRNG (mulberry32), so the random baseline is reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The "no edge" benchmark: entries at random closed bars from `fromIndex`,
 * with the strategy's own stop and target geometry (stop = k x ATR below,
 * target = m x that risk above), the same horizon and the same costs. A
 * strategy that cannot beat this is not selecting its moments well.
 */
export function randomEntryBaseline(i: {
  bars: readonly Candle[];
  fromIndex: number;
  count: number;
  seed: number;
  atrMultiplier: number;
  targetR: number;
  horizonBars: number;
  costs: CostModel;
}): number[] {
  const atrSeries = atr(i.bars as Candle[], 14);
  const rand = seededRandom(i.seed);
  const last = i.bars.length - 2;
  const out: number[] = [];
  if (last < i.fromIndex) return out;
  for (let k = 0; k < i.count; k++) {
    const t = i.fromIndex + Math.floor(rand() * (last - i.fromIndex + 1));
    const a = atrSeries[t];
    const bar = i.bars[t]!;
    if (a === null || a === undefined || a <= 0) continue;
    const stop = bar.close - i.atrMultiplier * a;
    const tp = bar.close + i.targetR * (bar.close - stop);
    const ev = evaluateSignal({
      entry: bar.close,
      stopLoss: stop,
      takeProfit: tp,
      forwardBars: i.bars.slice(t + 1),
      horizonBars: i.horizonBars,
      feeBps: 0,
      slippageBps: 0,
    });
    if (ev.exitPrice === null || ev.outcome === 'pending' || ev.outcome === 'unevaluable') continue;
    out.push(netReturnPct(bar.close, ev.exitPrice, i.costs));
  }
  return out;
}

export interface ValidationVerdict {
  label: 'validated' | 'experimental';
  /** Every unmet condition, so the page can say exactly why. */
  unmet: ('too_few_trades' | 'not_profitable' | 'weak_profit_factor' | 'no_better_than_random')[];
}

export const VALIDATION_RULES = { minTrades: 30, minProfitFactor: 1.1 } as const;

/**
 * "Validated" only when the OUT-OF-SAMPLE period - data the rules were never
 * looked at against - shows: at least 30 trades, a positive net expectancy
 * after Indodax costs, a profit factor above 1.1, and a better expectancy than
 * random entries with the same stop/target geometry. Anything less stays
 * "experimental"; a strategy is never promoted on in-sample results.
 */
export function validationVerdict(oos: {
  trades: number;
  expectancyPct: number | null;
  profitFactor: number | null;
  randomExpectancyPct: number | null;
}): ValidationVerdict {
  const unmet: ValidationVerdict['unmet'] = [];
  if (oos.trades < VALIDATION_RULES.minTrades) unmet.push('too_few_trades');
  if (oos.expectancyPct === null || oos.expectancyPct <= 0) unmet.push('not_profitable');
  // No losing trade at all leaves the profit factor undefined; with 30+ trades that is a pass.
  if (oos.profitFactor !== null && oos.profitFactor <= VALIDATION_RULES.minProfitFactor) unmet.push('weak_profit_factor');
  if (oos.expectancyPct === null || oos.randomExpectancyPct === null || oos.expectancyPct <= oos.randomExpectancyPct) {
    unmet.push('no_better_than_random');
  }
  return { label: unmet.length === 0 ? 'validated' : 'experimental', unmet };
}
