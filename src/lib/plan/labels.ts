import { formatIdr } from '@/lib/format';
import type { Messages } from '@/lib/i18n';
import type { EligibilityFailure, SetupState, StateReason, TradePlan } from './types';

/**
 * Words for a plan: pair, timeframe, strategy, state, rejection reasons and the
 * one-line instruction. Plain functions (no JSX), so the pages and the worker's
 * alerts say exactly the same thing.
 */

type T = Messages;

export function timeframeLabel(t: T, tf: string): string {
  return tf === '1h' ? t.plan.tf1h : tf === '4h' ? t.plan.tf4h : tf === '1d' ? t.plan.tf1d : tf;
}

export function strategyLabel(t: T, id: string): string {
  if (id === 'trend_follow_ema') return t.plan.strategyTrend;
  if (id === 'breakout_donchian') return t.plan.strategyBreakout;
  if (id === 'trend_momentum') return t.plan.strategyMomentum;
  return id;
}

/** "BTC/IDR" from the stored description, falling back to the symbol. */
export function pairLabel(plan: Pick<TradePlan, 'description' | 'symbol'>): string {
  return plan.description || plan.symbol;
}

export function stateLabel(t: T, state: SetupState): string {
  const map: Record<SetupState, string> = {
    BUY_NOW: t.plan.stateBuyNow,
    WAIT_FOR_ENTRY: t.plan.stateWait,
    NOT_ELIGIBLE: t.plan.stateNotEligible,
    MISSED: t.plan.stateMissed,
    INVALIDATED: t.plan.stateInvalidated,
    EXPIRED: t.plan.stateExpired,
    DATA_STALE: t.plan.stateStale,
  };
  return map[state];
}

export function failureText(t: T, plan: TradePlan, f: EligibilityFailure): string {
  switch (f) {
    case 'context_down':
      return t.plan.failContextDown(timeframeLabel(t, plan.contextTimeframe));
    case 'rr_too_low':
      return t.plan.failRrTooLow(plan.outcome.netRiskReward.toFixed(2), plan.eligibility.minNetRiskReward);
    case 'target_within_costs':
      return t.plan.failTargetWithinCosts(plan.outcome.tp1DistancePercent.toFixed(2), plan.costs.roundTripPercent.toFixed(2));
    case 'below_min_order':
      return t.plan.failBelowMinOrder;
    case 'no_capital':
      return t.plan.failNoCapital;
  }
}

/** One sentence: exactly what to do, at what price. */
export function actionLine(t: T, plan: TradePlan, state: SetupState, reason: StateReason): string | null {
  if (state === 'BUY_NOW') return t.plan.buyNowLine(formatIdr(plan.entry.max));
  if (state !== 'WAIT_FOR_ENTRY') return null;
  if (reason === 'awaiting_trigger' && plan.trigger) {
    const line = t.plan.triggerLine(timeframeLabel(t, plan.timeframe), formatIdr(plan.trigger.price));
    return plan.trigger.requiresVolume ? `${line} ${t.plan.triggerVolume}` : line;
  }
  return t.plan.pullbackLine(formatIdr(plan.entry.max));
}
