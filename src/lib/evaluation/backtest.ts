import type { AssetClass, Candle, Timeframe } from '@/lib/market/types';
import { buildIndicators } from '@/lib/strategies';
import type { Strategy } from '@/lib/strategies/types';
import { classifyRegime } from '@/lib/signals/regime';
import { defaultCostAssumptions } from '@/lib/signals/risk';
import { evaluateSignal } from './outcomes';
import { buyAndHoldReturnPct, computeMetrics, type PerformanceMetrics, type TradeRecord } from './metrics';

/**
 * Walk-forward backtest.
 *
 * NO-LOOKAHEAD CONTRACT - the single most important property of this file:
 *   At each step t the strategy sees ONLY bars[0..t]. Indicators are recomputed
 *   from that slice, so an indicator can never be influenced by a bar that had
 *   not yet closed. Outcomes are then measured on bars[t+1..], which the
 *   strategy never saw.
 *
 * Observations are never shuffled. The chronological order is the experiment.
 *
 * This is a simplified simulator: it assumes entry at the signal bar's close,
 * one unit of risk per trade, and no partial fills. It is a sanity check on
 * rule behaviour, NOT a claim about tradeable profitability.
 */

export interface BacktestOptions {
  strategy: Strategy;
  bars: readonly Candle[];
  timeframe: Timeframe;
  assetClass: AssetClass;
  /** Bars reserved for warm-up before the first possible signal. */
  warmupBars?: number;
  feeBps?: number;
  slippageBps?: number;
}

export interface BacktestTrade extends TradeRecord {
  index: number;
  entryTimeMs: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice: number | null;
  barsHeld: number;
  exitReason: string | null;
}

export interface BacktestResult {
  strategyId: string;
  strategyVersion: string;
  timeframe: Timeframe;
  barsTested: number;
  firstBarMs: number | null;
  lastBarMs: number | null;
  signalsGenerated: number;
  trades: BacktestTrade[];
  metrics: PerformanceMetrics;
  /** Same statistics including overlapping trades, for comparison only. */
  metricsIncludingOverlaps: PerformanceMetrics;
  benchmarkBuyHoldPct: number | null;
  warnings: string[];
}

export function runBacktest(options: BacktestOptions): BacktestResult {
  const { strategy, bars, timeframe, assetClass } = options;
  const warmup = options.warmupBars ?? strategy.warmupBars;
  const costs = defaultCostAssumptions(assetClass);
  const feeBps = options.feeBps ?? costs.feeBps;
  const slippageBps = options.slippageBps ?? costs.slippageBps;

  const warnings: string[] = [];
  const trades: BacktestTrade[] = [];
  let signalsGenerated = 0;

  if (bars.length <= warmup + strategy.evaluationHorizonBars) {
    warnings.push(
      `Not enough history: ${bars.length} bars for a strategy needing ${warmup} warm-up bars plus a ${strategy.evaluationHorizonBars}-bar horizon.`,
    );
    return {
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      timeframe,
      barsTested: 0,
      firstBarMs: bars[0]?.openTimeMs ?? null,
      lastBarMs: bars.at(-1)?.openTimeMs ?? null,
      signalsGenerated: 0,
      trades: [],
      metrics: computeMetrics([]),
      metricsIncludingOverlaps: computeMetrics([], true),
      benchmarkBuyHoldPct: null,
      warnings,
    };
  }

  /** Bar index at which the currently open trade stops being open. */
  let openUntilIndex = -1;

  for (let t = warmup; t < bars.length - 1; t++) {
    // The strategy sees only history up to and including bar t.
    const visible = bars.slice(0, t + 1);
    const indicators = buildIndicators(visible);
    const regime = classifyRegime(visible);

    const output = strategy.evaluate({
      bars: visible as Candle[],
      indicators,
      regime: regime.regime,
      timeframe,
      assetClass,
      // Position state is simulated by the backtester, not carried from the
      // live database, so a backtest is fully self-contained.
      hasOpenPosition: t <= openUntilIndex,
      openEntryPrice: null,
      openStopLoss: null,
      openTarget: null,
    });

    if (output.action !== 'BUY' || !output.levels) continue;
    signalsGenerated++;

    const entryBar = bars[t]!;
    const entry = entryBar.close;
    const { stopLoss, takeProfit1 } = output.levels;

    const evaluation = evaluateSignal({
      entry,
      stopLoss,
      takeProfit: takeProfit1,
      forwardBars: bars.slice(t + 1),
      horizonBars: strategy.evaluationHorizonBars,
      feeBps,
      slippageBps,
    });

    if (evaluation.returnPctNet === null) continue;

    const overlapsPrior = t <= openUntilIndex;
    trades.push({
      index: t,
      entryTimeMs: entryBar.openTimeMs,
      entry,
      stopLoss,
      takeProfit: takeProfit1,
      exitPrice: evaluation.exitPrice,
      barsHeld: evaluation.barsObserved,
      exitReason: evaluation.exitReason,
      returnPctNet: evaluation.returnPctNet,
      rMultiple: evaluation.rMultiple,
      outcome: evaluation.outcome,
      generatedAtMs: entryBar.openTimeMs,
      overlapsPrior,
    });

    if (!overlapsPrior) openUntilIndex = t + evaluation.barsObserved;
  }

  const metrics = computeMetrics(trades);
  if (metrics.overlappingExcluded > 0) {
    warnings.push(
      `${metrics.overlappingExcluded} overlapping trade(s) were excluded from the headline statistics because their outcomes are not independent.`,
    );
  }
  warnings.push(
    'Simulated at the signal bar close with no partial fills, no slippage model beyond a flat basis-point assumption, and no borrowing or funding costs.',
  );

  return {
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    timeframe,
    barsTested: bars.length - warmup - 1,
    firstBarMs: bars[warmup]?.openTimeMs ?? null,
    lastBarMs: bars.at(-1)?.openTimeMs ?? null,
    signalsGenerated,
    trades,
    metrics,
    metricsIncludingOverlaps: computeMetrics(trades, true),
    benchmarkBuyHoldPct: buyAndHoldReturnPct(bars[warmup]!.close, bars.at(-1)!.close),
    warnings,
  };
}

/**
 * Split a series into sequential walk-forward windows.
 * Chronological only - shuffling a time series would leak future information
 * into the "training" window and is never done here.
 */
export function walkForwardWindows(
  totalBars: number,
  windowSize: number,
  step: number,
): { start: number; end: number }[] {
  const windows: { start: number; end: number }[] = [];
  for (let start = 0; start + windowSize <= totalBars; start += step) {
    windows.push({ start, end: start + windowSize });
  }
  return windows;
}
