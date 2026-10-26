import type { BollingerResult, MaybeSeries, VolumeAnalysis } from '@/lib/indicators';
import type { AssetClass, Candle, MarketRegime, SetupStrength, SignalAction, Timeframe } from '@/lib/market/types';

/**
 * Strategy contract.
 *
 * A strategy is a pure function of (closed bars + precomputed indicators). It
 * never fetches data, never reads the clock, and never calls an LLM, so the
 * same inputs always reproduce the same output - which is what makes a stored
 * signal auditable and a backtest meaningful.
 */

/** A single rule outcome. Stored with the signal so the "why" is auditable. */
export interface RuleOutcome {
  id: string;
  description: string;
  passed: boolean;
  /** Concrete observed values, e.g. "RSI 58.2 > 50". */
  detail: string;
  /** A rule that cannot be evaluated (e.g. volume unavailable) is not a pass. */
  skipped?: boolean;
}

export interface StrategyLevels {
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number | null;
}

export interface StrategyOutput {
  action: SignalAction;
  strength: SetupStrength;
  rules: RuleOutcome[];
  risks: string[];
  invalidation: string[];
  levels: StrategyLevels | null;
  /** Human summary of the deterministic decision. No AI involved. */
  summary: string;
}

export interface IndicatorBundle {
  closes: number[];
  emaFast: MaybeSeries;
  emaSlow: MaybeSeries;
  emaLong: MaybeSeries;
  rsi: MaybeSeries;
  macdLine: MaybeSeries;
  macdSignal: MaybeSeries;
  macdHistogram: MaybeSeries;
  atr: MaybeSeries;
  bollinger: BollingerResult;
  volume: VolumeAnalysis;
  donchianUpper: MaybeSeries;
  donchianLower: MaybeSeries;
  support: number | null;
  resistance: number | null;
}

export interface StrategyContext {
  /** CLOSED bars only, chronological. The in-progress bar is excluded. */
  bars: Candle[];
  indicators: IndicatorBundle;
  regime: MarketRegime;
  timeframe: Timeframe;
  assetClass: AssetClass;
  /**
   * Whether an earlier BUY from this strategy is still open for this asset.
   * This is the app's proxy for "an existing holding": it decides whether the
   * strategy is asked for an ENTRY decision (BUY/WAIT) or an EXIT decision
   * (SELL/HOLD). This app never has real position data.
   */
  hasOpenPosition: boolean;
  /** Entry price of the open position, when one exists. */
  openEntryPrice: number | null;
  openStopLoss: number | null;
  openTarget: number | null;
}

export interface Strategy {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly assetClasses: AssetClass[];
  readonly timeframes: Timeframe[];
  /** Regimes in which this strategy is permitted to produce an entry. */
  readonly eligibleRegimes: MarketRegime[];
  /** Bars of history required before the strategy may run at all. */
  readonly warmupBars: number;
  readonly parameters: Record<string, number>;
  /** Evaluation horizon in bars, used by forward evaluation and backtests. */
  readonly evaluationHorizonBars: number;
  evaluate(ctx: StrategyContext): StrategyOutput;
}

/**
 * Setup strength from the number of satisfied confirmation rules.
 *
 * This is a COUNT of independent confirmations, not a probability and not a
 * weighted score. It says how much evidence lined up, and nothing about the
 * likelihood of profit. Documented in docs/SIGNAL_METHODOLOGY.md.
 */
export function strengthFromRules(rules: readonly RuleOutcome[]): SetupStrength {
  const evaluable = rules.filter((r) => !r.skipped);
  const passed = evaluable.filter((r) => r.passed).length;
  if (evaluable.length < 3) return 'insufficient';
  const ratio = passed / evaluable.length;
  if (passed === evaluable.length && evaluable.length >= 5) return 'strong';
  if (ratio >= 0.8) return 'moderate';
  if (ratio >= 0.6) return 'weak';
  return 'insufficient';
}

/** Numbers formatted consistently in rule details. */
export function fmt(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(digits);
}


/**
 * Human-readable summary of which exit conditions fired.
 *
 * The strategies used to emit `"Exit condition met: X1, X2."` — the rule IDs
 * and nothing else. That string is what the Portfolio page shows next to a
 * SELL badge, so the app was telling someone to sell real money and giving
 * them two opaque codes as the justification. The descriptions already existed
 * on every rule; they just never left the strategy.
 */
export function describeExits(rules: RuleOutcome[]): string {
  const fired = rules.filter((r) => r.passed);
  if (fired.length === 0) return '';
  return `Exit condition met — ${fired.map((r) => `${r.description} (${r.id}: ${r.detail})`).join('; ')}.`;
}

/**
 * Human-readable summary of which entry conditions did NOT fire.
 *
 * Same reasoning as `describeExits`: "failed: B1, B3" tells the reader
 * nothing. A WAIT is the answer most of the time, so this is the sentence the
 * user reads most often in the whole app — it should say something.
 */
export function describeFailures(rules: RuleOutcome[]): string {
  const failed = rules.filter((r) => !r.passed);
  if (failed.length === 0) return 'none';
  return failed.map((r) => `${r.description} (${r.id})`).join('; ');
}
