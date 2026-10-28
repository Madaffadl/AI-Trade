import 'server-only';
import { db } from '@/lib/db/driver';
import { getAssetById, newId, nowMs } from '@/lib/db/repo';
import { loadCandles } from '@/lib/db/repo';
import { TIMEFRAME_MS, type Timeframe } from '@/lib/market/types';
import { defaultCostAssumptions } from '@/lib/signals/risk';
import { STRATEGIES } from '@/lib/strategies';
import { evaluateSignal } from './outcomes';
import { computeMetrics, type PerformanceMetrics, type TradeRecord } from './metrics';

/**
 * Forward evaluation of signals this app actually generated.
 *
 * This is categorically different from a backtest: these signals were produced
 * live, before the outcome was known. The UI never mixes the two.
 */

export interface ForwardEvaluationSummary {
  evaluated: number;
  stillPending: number;
  unevaluable: number;
}

export async function evaluateStoredSignals(): Promise<ForwardEvaluationSummary> {
  const d = await db();
  const summary: ForwardEvaluationSummary = { evaluated: 0, stillPending: 0, unevaluable: 0 };

  const signals = await d.all<{
    id: string;
    asset_id: string;
    timeframe: Timeframe;
    strategy_id: string;
    action: string;
    candle_open_ms: number;
    price_at_signal: number;
    stop_loss: number | null;
    take_profit_1: number | null;
  }>(
    `SELECT id, asset_id, timeframe, strategy_id, action, candle_open_ms, price_at_signal, stop_loss, take_profit_1
     FROM trading_signals WHERE action = 'BUY' ORDER BY generated_at_ms DESC LIMIT 500`,
  );

  for (const s of signals) {
    const strategy = STRATEGIES.find((x) => x.id === s.strategy_id);
    if (!strategy) continue;
    const asset = await getAssetById(s.asset_id);
    if (!asset) continue;

    const stored = await loadCandles(s.asset_id, s.timeframe, 2000);
    const forwardBars = stored.candles.filter((c) => c.openTimeMs > s.candle_open_ms && !c.isPartial);

    const costs = await signalCosts(s.id, asset.assetClass);
    const result = evaluateSignal({
      entry: s.price_at_signal,
      stopLoss: s.stop_loss,
      takeProfit: s.take_profit_1,
      forwardBars,
      horizonBars: strategy.evaluationHorizonBars,
      feeBps: costs.feeBps,
      slippageBps: costs.slippageBps,
    });

    // Overlap detection: an earlier BUY on the same asset+strategy whose
    // horizon had not elapsed when this one fired.
    const horizonMs = strategy.evaluationHorizonBars * TIMEFRAME_MS[s.timeframe];
    const prior = await d.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM trading_signals
       WHERE asset_id = ? AND strategy_id = ? AND timeframe = ? AND action = 'BUY'
         AND candle_open_ms < ? AND candle_open_ms > ?`,
      [s.asset_id, s.strategy_id, s.timeframe, s.candle_open_ms, s.candle_open_ms - horizonMs],
    );
    const overlapsPrior = Number(prior?.n ?? 0) > 0;

    if (result.outcome === 'pending') summary.stillPending++;
    else if (result.outcome === 'unevaluable') summary.unevaluable++;
    else summary.evaluated++;

    await d.run(
      `INSERT INTO signal_evaluations
         (id, signal_id, evaluated_at_ms, horizon_bars, horizon_end_ms, bars_observed, outcome,
          exit_price, exit_reason, max_favorable_excursion, max_adverse_excursion,
          return_pct, return_pct_net, r_multiple, fee_assumption_bps, slippage_assumption_bps, overlaps_prior)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (signal_id, horizon_bars) DO UPDATE SET
         evaluated_at_ms = excluded.evaluated_at_ms,
         bars_observed = excluded.bars_observed,
         outcome = excluded.outcome,
         exit_price = excluded.exit_price,
         exit_reason = excluded.exit_reason,
         max_favorable_excursion = excluded.max_favorable_excursion,
         max_adverse_excursion = excluded.max_adverse_excursion,
         return_pct = excluded.return_pct,
         return_pct_net = excluded.return_pct_net,
         r_multiple = excluded.r_multiple,
         overlaps_prior = excluded.overlaps_prior`,
      [
        newId(),
        s.id,
        nowMs(),
        strategy.evaluationHorizonBars,
        s.candle_open_ms + horizonMs,
        result.barsObserved,
        result.outcome,
        result.exitPrice,
        result.exitReason,
        result.maxFavorableExcursion,
        result.maxAdverseExcursion,
        result.returnPct,
        result.returnPctNet,
        result.rMultiple,
        costs.feeBps,
        costs.slippageBps,
        overlapsPrior ? 1 : 0,
      ],
    );
  }

  return summary;
}

export interface ForwardPerformance {
  strategyId: string;
  metrics: ReturnType<typeof computeMetrics>;
}

export async function forwardPerformanceByStrategy(): Promise<ForwardPerformance[]> {
  const d = await db();
  const rows = await d.all<{
    strategy_id: string;
    return_pct_net: number | null;
    r_multiple: number | null;
    outcome: string;
    generated_at_ms: number;
    overlaps_prior: number;
  }>(
    `SELECT s.strategy_id, e.return_pct_net, e.r_multiple, e.outcome, s.generated_at_ms, e.overlaps_prior
     FROM signal_evaluations e JOIN trading_signals s ON s.id = e.signal_id
     WHERE e.outcome NOT IN ('pending','unevaluable')`,
  );

  const byStrategy = new Map<string, TradeRecord[]>();
  for (const r of rows) {
    if (r.return_pct_net === null) continue;
    const list = byStrategy.get(r.strategy_id) ?? [];
    list.push({
      returnPctNet: r.return_pct_net,
      rMultiple: r.r_multiple,
      outcome: r.outcome,
      generatedAtMs: r.generated_at_ms,
      overlapsPrior: r.overlaps_prior === 1,
    });
    byStrategy.set(r.strategy_id, list);
  }

  return STRATEGIES.map((s) => ({
    strategyId: s.id,
    metrics: computeMetrics(byStrategy.get(s.id) ?? []),
  }));
}

export async function listEvaluations(limit = 100) {
  const d = await db();
  return d.all<{
    signal_id: string;
    symbol: string;
    action: string;
    strategy_id: string;
    timeframe: string;
    generated_at_ms: number;
    outcome: string;
    return_pct_net: number | null;
    r_multiple: number | null;
    bars_observed: number;
    exit_reason: string | null;
    overlaps_prior: number;
  }>(
    `SELECT e.signal_id, a.symbol, s.action, s.strategy_id, s.timeframe, s.generated_at_ms,
            e.outcome, e.return_pct_net, e.r_multiple, e.bars_observed, e.exit_reason, e.overlaps_prior
     FROM signal_evaluations e
     JOIN trading_signals s ON s.id = e.signal_id
     JOIN assets a ON a.id = s.asset_id
     ORDER BY s.generated_at_ms DESC LIMIT ?`,
    [limit],
  );
}

/**
 * Per-side costs for scoring a signal. An Indodax plan carries its own cost
 * model (taker fee, sale tax, levies, measured spread); its round trip is
 * split evenly over the two sides, which keeps the total exact. Signals
 * without a plan fall back to the generic assumption.
 */
async function signalCosts(signalId: string, assetClass: 'crypto' | 'stock'): Promise<{ feeBps: number; slippageBps: number }> {
  const d = await db();
  const row = await d.get<{ plan_json: string }>(
    'SELECT plan_json FROM trade_setups WHERE signal_id = ? ORDER BY created_at_ms DESC LIMIT 1',
    [signalId],
  );
  if (row) {
    try {
      const plan = JSON.parse(row.plan_json) as { costs?: { roundTripPercent?: number } };
      const roundTrip = plan.costs?.roundTripPercent;
      if (typeof roundTrip === 'number' && Number.isFinite(roundTrip)) return { feeBps: (roundTrip * 100) / 2, slippageBps: 0 };
    } catch {
      // fall through to the generic assumption
    }
  }
  return defaultCostAssumptions(assetClass);
}

/** Resolved live-signal outcomes per strategy x timeframe, keyed "strategyId|timeframe". */
export async function forwardMetricsByStrategyTimeframe(): Promise<Map<string, PerformanceMetrics>> {
  const d = await db();
  const rows = await d.all<{
    strategy_id: string;
    timeframe: string;
    return_pct_net: number;
    r_multiple: number | null;
    outcome: string;
    generated_at_ms: number;
    overlaps_prior: number;
  }>(
    `SELECT s.strategy_id, s.timeframe, e.return_pct_net, e.r_multiple, e.outcome, s.generated_at_ms, e.overlaps_prior
       FROM signal_evaluations e JOIN trading_signals s ON s.id = e.signal_id
      WHERE e.outcome NOT IN ('pending', 'unevaluable') AND e.return_pct_net IS NOT NULL`,
  );
  const groups = new Map<string, TradeRecord[]>();
  for (const r of rows) {
    const key = `${r.strategy_id}|${r.timeframe}`;
    const list = groups.get(key) ?? [];
    list.push({
      returnPctNet: r.return_pct_net,
      rMultiple: r.r_multiple,
      outcome: r.outcome,
      generatedAtMs: r.generated_at_ms,
      overlapsPrior: r.overlaps_prior === 1,
    });
    groups.set(key, list);
  }
  return new Map([...groups].map(([k, v]) => [k, computeMetrics(v)]));
}
