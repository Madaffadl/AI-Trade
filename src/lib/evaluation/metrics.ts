/**
 * Performance statistics.
 *
 * Every metric here is a plain description of the supplied trades. None of them
 * is predictive, and the sample sizes produced by a personal watchlist over a
 * short period are far too small to support any claim about profitability. The
 * UI states that alongside the numbers.
 */

export interface TradeRecord {
  /** Net return in percent, after assumed fees and slippage. */
  returnPctNet: number;
  rMultiple: number | null;
  outcome: string;
  generatedAtMs: number;
  /** True when this trade overlapped an earlier open trade on the same asset+strategy. */
  overlapsPrior: boolean;
}

export interface PerformanceMetrics {
  trades: number;
  /** Trades excluded from the independent sample because they overlapped. */
  overlappingExcluded: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: number | null;
  averageGainPct: number | null;
  averageLossPct: number | null;
  expectancyPct: number | null;
  expectancyR: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number | null;
  totalReturnPct: number;
  bestPct: number | null;
  worstPct: number | null;
  /** Explicit warning when the sample is too small to interpret. */
  sampleWarning: string | null;
}

const MIN_MEANINGFUL_SAMPLE = 30;

/**
 * `includeOverlapping = false` (the default) drops trades that overlapped an
 * earlier open trade on the same asset+strategy. Counting them would treat
 * correlated outcomes as independent observations and inflate the apparent
 * sample size.
 */
export function computeMetrics(all: readonly TradeRecord[], includeOverlapping = false): PerformanceMetrics {
  const overlappingExcluded = all.filter((t) => t.overlapsPrior).length;
  const trades = includeOverlapping ? [...all] : all.filter((t) => !t.overlapsPrior);

  if (trades.length === 0) {
    return {
      trades: 0,
      overlappingExcluded,
      wins: 0,
      losses: 0,
      breakeven: 0,
      winRatePct: null,
      averageGainPct: null,
      averageLossPct: null,
      expectancyPct: null,
      expectancyR: null,
      profitFactor: null,
      maxDrawdownPct: null,
      totalReturnPct: 0,
      bestPct: null,
      worstPct: null,
      sampleWarning: 'No completed trades yet. No performance claim can be made.',
    };
  }

  const sorted = [...trades].sort((a, b) => a.generatedAtMs - b.generatedAtMs);
  const returns = sorted.map((t) => t.returnPctNet);
  const gains = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r < 0);
  const breakeven = returns.filter((r) => r === 0).length;

  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);

  const grossProfit = sum(gains);
  const grossLoss = Math.abs(sum(losses));

  // Equity curve on a per-trade basis (each trade risks the same notional),
  // used only to describe the historical sequence of outcomes.
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const r of returns) {
    equity += r;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  const rMultiples = sorted.map((t) => t.rMultiple).filter((r): r is number => r !== null);

  return {
    trades: sorted.length,
    overlappingExcluded,
    wins: gains.length,
    losses: losses.length,
    breakeven,
    winRatePct: (gains.length / sorted.length) * 100,
    averageGainPct: avg(gains),
    averageLossPct: avg(losses),
    expectancyPct: avg(returns),
    expectancyR: rMultiples.length ? sum(rMultiples) / rMultiples.length : null,
    // Profit factor is undefined rather than Infinity when there are no losses.
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
    maxDrawdownPct: maxDrawdown,
    totalReturnPct: sum(returns),
    bestPct: Math.max(...returns),
    worstPct: Math.min(...returns),
    sampleWarning:
      sorted.length < MIN_MEANINGFUL_SAMPLE
        ? `Only ${sorted.length} trade(s). At least ${MIN_MEANINGFUL_SAMPLE} are needed before these statistics mean anything, and even then they are descriptive, not predictive.`
        : null,
  };
}

/** Buy-and-hold benchmark over the same window, for comparison. */
export function buyAndHoldReturnPct(firstClose: number, lastClose: number): number | null {
  if (!Number.isFinite(firstClose) || firstClose === 0) return null;
  return ((lastClose - firstClose) / firstClose) * 100;
}
