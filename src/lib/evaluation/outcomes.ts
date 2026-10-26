import type { Candle } from '@/lib/market/types';

/**
 * Outcome evaluation for a single long setup.
 *
 * Rules that matter for honesty:
 *  - A brief favourable excursion is NOT a win. The outcome is decided by
 *    whether the STOP or the TARGET was reached first, or by the price at the
 *    end of a fixed horizon - never by the best price seen along the way.
 *    Maximum favourable/adverse excursion are recorded separately as
 *    diagnostics only.
 *  - When a single bar's range contains BOTH the stop and the target, intrabar
 *    sequence is unknowable from OHLC data. This evaluator assumes the STOP was
 *    hit first. That is the pessimistic assumption, and it is applied
 *    consistently so results are not flattered by ambiguity.
 *  - Costs are charged on both entry and exit.
 */

export type Outcome =
  | 'pending'
  | 'target_hit'
  | 'stop_hit'
  | 'timeout_gain'
  | 'timeout_loss'
  | 'unevaluable';

export interface EvaluationInput {
  entry: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Bars strictly AFTER the signal bar, in chronological order. */
  forwardBars: readonly Candle[];
  horizonBars: number;
  feeBps: number;
  slippageBps: number;
}

export interface EvaluationOutput {
  outcome: Outcome;
  barsObserved: number;
  exitPrice: number | null;
  exitReason: string | null;
  maxFavorableExcursion: number | null;
  maxAdverseExcursion: number | null;
  returnPct: number | null;
  returnPctNet: number | null;
  rMultiple: number | null;
  /** True when the horizon has not fully elapsed yet. */
  incomplete: boolean;
}

export function evaluateSignal(input: EvaluationInput): EvaluationOutput {
  const { entry, stopLoss, takeProfit, forwardBars, horizonBars, feeBps, slippageBps } = input;

  const empty: EvaluationOutput = {
    outcome: 'unevaluable',
    barsObserved: 0,
    exitPrice: null,
    exitReason: null,
    maxFavorableExcursion: null,
    maxAdverseExcursion: null,
    returnPct: null,
    returnPctNet: null,
    rMultiple: null,
    incomplete: false,
  };

  if (!Number.isFinite(entry) || entry <= 0) {
    return { ...empty, exitReason: 'Invalid entry price.' };
  }
  if (stopLoss === null || takeProfit === null) {
    return { ...empty, exitReason: 'Signal has no stop-loss or no target, so an outcome cannot be defined.' };
  }
  if (stopLoss >= entry || takeProfit <= entry) {
    return { ...empty, exitReason: 'Stop/target geometry is invalid for a long setup.' };
  }

  const window = forwardBars.slice(0, horizonBars);
  if (window.length === 0) {
    return { ...empty, outcome: 'pending', incomplete: true, exitReason: 'No bars have formed since the signal.' };
  }

  const costFraction = (feeBps + slippageBps) / 10_000;
  const riskPerUnit = entry - stopLoss;

  let mfe = -Infinity;
  let mae = Infinity;

  for (let i = 0; i < window.length; i++) {
    const bar = window[i]!;
    mfe = Math.max(mfe, bar.high);
    mae = Math.min(mae, bar.low);

    const hitStop = bar.low <= stopLoss;
    const hitTarget = bar.high >= takeProfit;

    if (hitStop || hitTarget) {
      // Pessimistic tie-break: when both levels sit inside one bar, assume the
      // stop was reached first.
      const exitPrice = hitStop ? stopLoss : takeProfit;
      const outcome: Outcome = hitStop ? 'stop_hit' : 'target_hit';
      return finish({
        outcome,
        barsObserved: i + 1,
        exitPrice,
        exitReason: hitStop
          ? hitTarget
            ? 'Stop and target both inside one bar; stop assumed first (pessimistic).'
            : 'Stop-loss reached.'
          : 'Take-profit reached.',
        entry,
        riskPerUnit,
        costFraction,
        mfe,
        mae,
        incomplete: false,
      });
    }
  }

  const incomplete = window.length < horizonBars;
  const lastClose = window.at(-1)!.close;
  const outcome: Outcome = incomplete ? 'pending' : lastClose >= entry ? 'timeout_gain' : 'timeout_loss';

  return finish({
    outcome,
    barsObserved: window.length,
    exitPrice: incomplete ? null : lastClose,
    exitReason: incomplete
      ? `Horizon not yet complete (${window.length}/${horizonBars} bars).`
      : 'Evaluation horizon elapsed without hitting the stop or the target; exited at the close.',
    entry,
    riskPerUnit,
    costFraction,
    mfe,
    mae,
    incomplete,
  });
}

function finish(args: {
  outcome: Outcome;
  barsObserved: number;
  exitPrice: number | null;
  exitReason: string;
  entry: number;
  riskPerUnit: number;
  costFraction: number;
  mfe: number;
  mae: number;
  incomplete: boolean;
}): EvaluationOutput {
  const { entry, riskPerUnit, costFraction, exitPrice } = args;

  const returnPct = exitPrice === null ? null : ((exitPrice - entry) / entry) * 100;
  // Costs are charged once on entry and once on exit.
  const returnPctNet = returnPct === null ? null : returnPct - costFraction * 2 * 100;
  const rMultiple =
    exitPrice === null || riskPerUnit <= 0
      ? null
      : (exitPrice - entry - entry * costFraction * 2) / riskPerUnit;

  return {
    outcome: args.outcome,
    barsObserved: args.barsObserved,
    exitPrice,
    exitReason: args.exitReason,
    maxFavorableExcursion: Number.isFinite(args.mfe) ? ((args.mfe - entry) / entry) * 100 : null,
    maxAdverseExcursion: Number.isFinite(args.mae) ? ((args.mae - entry) / entry) * 100 : null,
    returnPct,
    returnPctNet,
    rMultiple,
    incomplete: args.incomplete,
  };
}
