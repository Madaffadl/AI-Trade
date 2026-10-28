import type { RuleOutcome } from '@/lib/strategies/types';
import type { CostModel } from './costs';

/**
 * Shared types of the trading-plan engine.
 *
 * A *setup* is one strategy's opinion about one pair on one entry timeframe.
 * A *plan* is that setup turned into instructions: where to buy, the highest
 * price still worth paying, stop, targets, IDR amount, costs and how long to
 * hold. Every number in a plan is computed deterministically; the AI layer
 * only ever explains it.
 */

/** Bump when plan arithmetic or state rules change, so stored plans stay attributable. */
export const PLAN_ENGINE_VERSION = '1.0.0';

export type EntryTimeframe = '1h' | '4h';
export type ContextTimeframe = '4h' | '1d';

/** Entry timeframe and the higher timeframe whose trend it must agree with. */
export const ENTRY_PLANS: readonly { timeframe: EntryTimeframe; context: ContextTimeframe }[] = [
  { timeframe: '1h', context: '4h' },
  { timeframe: '4h', context: '1d' },
];

/**
 * Strategies used for Indodax plans (mean-reversion produced no signal in any
 * recorded history). Each only runs on the entry timeframes it lists.
 */
export const PLAN_STRATEGY_IDS = ['trend_follow_ema', 'breakout_donchian', 'trend_momentum'] as const;

/** A setup is acted on within this many entry bars, or it expires. */
export const ENTRY_WINDOW_BARS = 3;

/** 'triggered': the strategy's entry fired on the latest closed bar. 'pending': one condition short. */
export type SetupKind = 'triggered' | 'pending';

export type SetupState =
  | 'BUY_NOW'
  | 'WAIT_FOR_ENTRY'
  | 'NOT_ELIGIBLE'
  | 'MISSED'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'DATA_STALE';

/** States that belong on the decision screen. */
export const ACTIONABLE_STATES: readonly SetupState[] = ['BUY_NOW', 'WAIT_FOR_ENTRY'];

export type StateReason =
  | 'actionable'
  | 'awaiting_trigger'
  | 'above_max_entry'
  | 'not_eligible'
  | 'below_stop'
  | 'left_trigger_zone'
  | 'target_passed'
  | 'expired'
  | 'stale_data';

export type EligibilityFailure = 'context_down' | 'rr_too_low' | 'target_within_costs' | 'below_min_order' | 'no_capital';

/** Whether a strategy x timeframe has passed out-of-sample validation after costs. */
export type ValidationLabel = 'validated' | 'experimental';

export interface TrendContext {
  timeframe: ContextTimeframe;
  up: boolean;
  /** 0..1 - how far the fast EMA sits above the slow one (5% apart = 1). Not a probability. */
  strength: number;
  close: number | null;
  emaFast: number | null;
  emaSlow: number | null;
}

export interface SizingResult {
  ok: boolean;
  failure: 'no_capital' | 'below_min_order' | null;
  quantity: number;
  notionalIdr: number;
  entryCostIdr: number;
  riskBudgetIdr: number;
  /** Loss in IDR if the stop is hit, including fees, tax and spread. */
  lossAtStopIdr: number;
  effectiveRiskPercent: number;
  /** Which limit set the size: the risk budget, the per-asset allocation cap, or cash on hand. */
  limitedBy: 'risk' | 'allocation' | 'cash';
}

export interface TradePlan {
  engineVersion: string;
  assetId: string;
  symbol: string;
  description: string;
  strategyId: string;
  strategyVersion: string;
  strategyName: string;
  timeframe: EntryTimeframe;
  contextTimeframe: ContextTimeframe;
  kind: SetupKind;
  /** The closed bar that produced the setup. */
  signalBarOpenMs: number;
  signalBarCloseMs: number;
  /** For pending setups: the close that turns it into an entry. */
  trigger: { price: number; requiresVolume: boolean } | null;
  entry: {
    /** Price the plan's numbers are computed at. */
    planned: number;
    low: number;
    /** Highest price still worth paying: beyond it the reward:risk after costs is too poor, or it is a chase. */
    max: number;
  };
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number | null;
  costs: CostModel & { roundTripPercent: number };
  sizing: SizingResult;
  outcome: {
    netRiskReward: number;
    grossRiskReward: number;
    stopDistancePercent: number;
    tp1DistancePercent: number;
    netProfitTp1Idr: number;
    netProfitTp2Idr: number | null;
  };
  holding: { horizonBars: number; horizonMs: number };
  expiresAtMs: number;
  atr: number;
  context: TrendContext;
  /** `minNetRiskReward` is the threshold the plan was judged against, kept so the verdict is reproducible. */
  eligibility: { ok: boolean; failures: EligibilityFailure[]; minNetRiskReward: number };
  rules: RuleOutcome[];
  risks: string[];
  invalidation: string[];
  summary: string;
}
