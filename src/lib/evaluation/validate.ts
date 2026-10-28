import 'server-only';
import { db } from '@/lib/db/driver';
import { loadCandles, newId, nowMs } from '@/lib/db/repo';
import { backfillCandles } from '@/lib/indodax/history';
import { refreshUniverse } from '@/lib/indodax/universe';
import { closedOnly } from '@/lib/market/normalize';
import type { AssetRef, Candle } from '@/lib/market/types';
import { buildCostModel, type CostModel } from '@/lib/plan/costs';
import { ENTRY_PLANS, PLAN_ENGINE_VERSION, PLAN_STRATEGY_IDS, type ValidationLabel } from '@/lib/plan/types';
import { getTradingSettings } from '@/lib/settings/trading';
import { STRATEGIES } from '@/lib/strategies';
import { buyAndHoldReturnPct, computeMetrics, type PerformanceMetrics, type TradeRecord } from './metrics';
import {
  backtestPlans,
  randomEntryBaseline,
  validationVerdict,
  type PlanBacktestResult,
  type PlanBacktestTrade,
  type ValidationVerdict,
} from './plan-backtest';

/**
 * Strategy validation on Indodax history.
 *
 * For every strategy x entry timeframe, trades from every pair in the scan
 * universe are pooled (per-pair samples are far too small on their own), then
 * split by TIME: the first 60% of the period is in-sample, the last 40%
 * out-of-sample. Only the out-of-sample figures decide the label (see
 * `validationVerdict`). Parameters are never tuned to these results.
 */

/** How much history each timeframe is validated on (1d is only the context for 4h). */
export const VALIDATION_DAYS = { '1h': 180, '4h': 400, '1d': 500 } as const;
const IN_SAMPLE_SHARE = 0.6;
const RANDOM_ENTRIES_PER_PAIR = 100;

export interface ValidationRow {
  id: string;
  strategy_id: string;
  strategy_version: string;
  engine_version: string;
  timeframe: string;
  computed_at_ms: number;
  period_from_ms: number | null;
  split_at_ms: number | null;
  period_to_ms: number | null;
  pairs: number;
  signals: number;
  rejected_json: string;
  in_sample_json: string;
  out_of_sample_json: string;
  random_expectancy_pct: number | null;
  random_trades: number;
  buy_hold_pct: number | null;
  label: ValidationLabel;
  unmet_json: string;
}

export interface StrategyValidation extends ValidationRow {
  rejected: PlanBacktestResult['rejected'];
  inSample: PerformanceMetrics;
  outOfSample: PerformanceMetrics;
  unmet: ValidationVerdict['unmet'];
}

function hydrate(r: ValidationRow): StrategyValidation {
  return {
    ...r,
    rejected: JSON.parse(r.rejected_json),
    inSample: JSON.parse(r.in_sample_json),
    outOfSample: JSON.parse(r.out_of_sample_json),
    unmet: JSON.parse(r.unmet_json),
  };
}

/** The newest validation of each strategy x timeframe, keyed "strategyId|timeframe". */
export async function latestValidations(): Promise<Map<string, StrategyValidation>> {
  const d = await db();
  const rows = await d.all<ValidationRow>(
    `SELECT v.* FROM strategy_validations v
      JOIN (SELECT strategy_id, timeframe, MAX(computed_at_ms) AS m FROM strategy_validations GROUP BY strategy_id, timeframe) l
        ON l.strategy_id = v.strategy_id AND l.timeframe = v.timeframe AND l.m = v.computed_at_ms`,
  );
  return new Map(rows.map((r) => [`${r.strategy_id}|${r.timeframe}`, hydrate(r)]));
}

/** The out-of-sample result of a strategy x timeframe's newest validation, in the terms the AI prompt uses. */
export async function outOfSampleFor(
  strategyId: string,
  timeframe: string,
): Promise<{ trades: number; expectancyPct: number | null; profitFactor: number | null } | null> {
  const v = (await latestValidations()).get(`${strategyId}|${timeframe}`);
  return v ? { trades: v.outOfSample.trades, expectancyPct: v.outOfSample.expectancyPct, profitFactor: v.outOfSample.profitFactor } : null;
}

function toRecords(trades: readonly PlanBacktestTrade[]): TradeRecord[] {
  return trades.map((t) => ({
    returnPctNet: t.netPct,
    rMultiple: t.rMultiple,
    outcome: t.outcome,
    generatedAtMs: t.entryTimeMs,
    overlapsPrior: false,
  }));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

interface PairData {
  symbol: string;
  costs: CostModel;
  bars: Record<'1h' | '4h' | '1d', Candle[]>;
}

export async function runValidation(options: { backfill?: boolean; log?: (line: string) => void } = {}): Promise<StrategyValidation[]> {
  const log = options.log ?? (() => {});
  const settings = await getTradingSettings();
  const universe = await refreshUniverse();
  const pairs: PairData[] = [];

  for (const p of universe.pairs) {
    const asset: AssetRef = {
      id: p.assetId, symbol: p.symbol, displayName: p.description, assetClass: 'crypto', exchangeId: 'INDODAX',
      currency: 'IDR', tickSize: p.priceIncrement, lotSize: p.quantityIncrement, minNotional: p.minOrderIdr,
    };
    const bars = {} as PairData['bars'];
    for (const tf of ['1h', '4h', '1d'] as const) {
      if (options.backfill !== false) {
        try {
          const n = await backfillCandles(asset, tf, VALIDATION_DAYS[tf]);
          if (n > 0) log(`  ${p.symbol} ${tf}: +${n} candles`);
        } catch (err) {
          log(`  ${p.symbol} ${tf}: backfill failed (${err instanceof Error ? err.message : String(err)}) - using stored candles`);
        }
      }
      const since = Date.now() - VALIDATION_DAYS[tf] * 86_400_000;
      bars[tf] = closedOnly((await loadCandles(p.assetId, tf, 20_000)).candles).filter((c) => c.openTimeMs >= since);
    }
    pairs.push({
      symbol: p.symbol,
      costs: buildCostModel({
        takerFeePercent: p.takerFeePercent,
        spreadPercent: p.spreadPercent,
        sellTaxPercent: settings.sellTaxPercent,
        otherFeePercentPerSide: settings.otherFeePercentPerSide,
      }),
      bars,
    });
  }

  const out: StrategyValidation[] = [];
  const computedAt = nowMs();
  for (const { timeframe, context } of ENTRY_PLANS) {
    for (const strategyId of PLAN_STRATEGY_IDS) {
      const strategy = STRATEGIES.find((s) => s.id === strategyId);
      if (!strategy || !strategy.timeframes.includes(timeframe)) continue;

      const perPair = pairs.map((p) => ({
        pair: p,
        result: backtestPlans({
          strategy,
          timeframe,
          contextTimeframe: context,
          bars: p.bars[timeframe],
          contextBars: p.bars[context],
          costs: p.costs,
          minNetRiskReward: settings.minNetRiskReward,
        }),
      }));

      const starts = pairs.map((p) => p.bars[timeframe][strategy.warmupBars]?.closeTimeMs).filter((v): v is number => v !== undefined);
      const ends = pairs.map((p) => p.bars[timeframe].at(-1)?.closeTimeMs).filter((v): v is number => v !== undefined);
      const from = starts.length ? Math.min(...starts) : null;
      const to = ends.length ? Math.max(...ends) : null;
      const split = from !== null && to !== null ? from + (to - from) * IN_SAMPLE_SHARE : null;

      const trades = perPair.flatMap((x) => x.result.trades);
      const inSample = computeMetrics(toRecords(trades.filter((t) => split !== null && t.entryTimeMs < split)));
      const outOfSample = computeMetrics(toRecords(trades.filter((t) => split !== null && t.entryTimeMs >= split)));

      // Benchmarks over the out-of-sample period only.
      const randomReturns: number[] = [];
      const buyHold: number[] = [];
      for (const { pair } of perPair) {
        const b = pair.bars[timeframe];
        const fromIndex = split === null ? -1 : b.findIndex((c) => c.closeTimeMs >= split);
        if (fromIndex < 0) continue;
        randomReturns.push(
          ...randomEntryBaseline({
            bars: b,
            fromIndex,
            count: RANDOM_ENTRIES_PER_PAIR,
            seed: hash(`${strategyId}|${timeframe}|${pair.symbol}`),
            atrMultiplier: strategy.parameters.atrMultiplier ?? 1.5,
            targetR: strategy.parameters.target1R ?? 1.5,
            horizonBars: strategy.evaluationHorizonBars,
            costs: pair.costs,
          }),
        );
        const bh = buyAndHoldReturnPct(b[fromIndex]!.close, b.at(-1)!.close);
        if (bh !== null) buyHold.push(bh);
      }
      const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
      const randomExpectancy = mean(randomReturns);
      const verdict = validationVerdict({
        trades: outOfSample.trades,
        expectancyPct: outOfSample.expectancyPct,
        profitFactor: outOfSample.profitFactor,
        randomExpectancyPct: randomExpectancy,
      });

      const rejected: PlanBacktestResult['rejected'] = {};
      for (const x of perPair) {
        for (const [k, v] of Object.entries(x.result.rejected)) {
          rejected[k as keyof typeof rejected] = (rejected[k as keyof typeof rejected] ?? 0) + (v ?? 0);
        }
      }
      const row: ValidationRow = {
        id: newId(),
        strategy_id: strategy.id,
        strategy_version: strategy.version,
        engine_version: PLAN_ENGINE_VERSION,
        timeframe,
        computed_at_ms: computedAt,
        period_from_ms: from,
        split_at_ms: split === null ? null : Math.round(split),
        period_to_ms: to,
        pairs: pairs.filter((p) => p.bars[timeframe].length > strategy.warmupBars).length,
        signals: perPair.reduce((a, x) => a + x.result.signals, 0),
        rejected_json: JSON.stringify(rejected),
        in_sample_json: JSON.stringify(inSample),
        out_of_sample_json: JSON.stringify(outOfSample),
        random_expectancy_pct: randomExpectancy,
        random_trades: randomReturns.length,
        buy_hold_pct: mean(buyHold),
        label: verdict.label,
        unmet_json: JSON.stringify(verdict.unmet),
      };
      const d = await db();
      await d.run(
        `INSERT INTO strategy_validations
           (id, strategy_id, strategy_version, engine_version, timeframe, computed_at_ms, period_from_ms, split_at_ms,
            period_to_ms, pairs, signals, rejected_json, in_sample_json, out_of_sample_json, random_expectancy_pct,
            random_trades, buy_hold_pct, label, unmet_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          row.id, row.strategy_id, row.strategy_version, row.engine_version, row.timeframe, row.computed_at_ms,
          row.period_from_ms, row.split_at_ms, row.period_to_ms, row.pairs, row.signals, row.rejected_json,
          row.in_sample_json, row.out_of_sample_json, row.random_expectancy_pct, row.random_trades, row.buy_hold_pct,
          row.label, row.unmet_json,
        ],
      );
      out.push(hydrate(row));
    }
  }
  return out;
}
