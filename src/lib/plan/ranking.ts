import type { SetupState, TradePlan, ValidationLabel } from './types';

/**
 * Ranking of eligible setups - documented, deterministic, and NOT a
 * probability of profit.
 *
 *   score = 0.30 x validation      1 if the strategy x timeframe passed out-of-sample
 *                                  validation after costs, 0.3 while experimental
 *         + 0.25 x reward:risk     net R:R to TP1, capped at 3, scaled to 0..1
 *         + 0.15 x liquidity       24h IDR turnover on a log scale: Rp1bn = 0, Rp100bn+ = 1
 *         + 0.15 x trend           higher-timeframe trend strength (0..1)
 *         + 0.15 x proximity       1 when buyable now; falls as the price is further
 *                                  from the planned entry (3% away = 0)
 *         - 0.10 x spread          spread as a share of the allowed maximum
 *
 * Ordering puts every BUY_NOW before any WAIT_FOR_ENTRY: a setup you can act
 * on beats a better-scored one you cannot act on yet. Ties break on symbol so
 * the order is reproducible.
 */

export interface RankInput {
  plan: TradePlan;
  state: SetupState;
  validation: ValidationLabel;
  volumeIdr: number | null;
  spreadPercent: number;
  maxSpreadPercent: number;
  ask: number | null;
}

export interface ScoreBreakdown {
  validation: number;
  riskReward: number;
  liquidity: number;
  trend: number;
  proximity: number;
  spreadPenalty: number;
  score: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function scoreSetup(i: RankInput): ScoreBreakdown {
  const validation = i.validation === 'validated' ? 1 : 0.3;
  const riskReward = clamp01(i.plan.outcome.netRiskReward / 3);
  const liquidity = i.volumeIdr && i.volumeIdr > 0 ? clamp01((Math.log10(i.volumeIdr) - 9) / 2) : 0;
  const trend = clamp01(i.plan.context.strength);
  const proximity =
    i.state === 'BUY_NOW'
      ? 1
      : i.ask === null
        ? 0
        : clamp01(1 - Math.abs(i.ask - i.plan.entry.planned) / i.plan.entry.planned / 0.03);
  const spreadPenalty = clamp01(i.spreadPercent / Math.max(i.maxSpreadPercent, 1e-9));
  const score =
    0.3 * validation + 0.25 * riskReward + 0.15 * liquidity + 0.15 * trend + 0.15 * proximity - 0.1 * spreadPenalty;
  return { validation, riskReward, liquidity, trend, proximity, spreadPenalty, score: Number(score.toFixed(4)) };
}

const STATE_ORDER: Partial<Record<SetupState, number>> = { BUY_NOW: 0, WAIT_FOR_ENTRY: 1 };

export function rankSetups<T extends { state: SetupState; score: number; plan: TradePlan }>(items: readonly T[]): T[] {
  return [...items]
    .filter((x) => STATE_ORDER[x.state] !== undefined)
    .sort(
      (a, b) =>
        STATE_ORDER[a.state]! - STATE_ORDER[b.state]! ||
        b.score - a.score ||
        a.plan.symbol.localeCompare(b.plan.symbol) ||
        a.plan.timeframe.localeCompare(b.plan.timeframe),
    );
}
