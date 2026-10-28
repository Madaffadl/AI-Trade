import 'server-only';
import { getAssetById } from '@/lib/db/repo';
import { closedOnly } from '@/lib/market/normalize';
import { getSeries } from '@/lib/market/service';
import { isTimeframe, TIMEFRAME_MS, type DataQuality, type SignalAction } from '@/lib/market/types';
import { classifyRegime } from '@/lib/signals/regime';
import { buildIndicators, STRATEGIES } from '@/lib/strategies';
import type { RuleOutcome } from '@/lib/strategies/types';
import type { PositionRow, PositionWithAsset } from './repo';

/**
 * The live plan for an open position.
 *
 * This is the answer to "I already bought - what now?". Everything is computed
 * against the price the USER actually paid, not against the theoretical entry
 * of the signal that inspired the trade. Those two numbers are almost never
 * the same, and using the wrong one misstates every risk figure that follows.
 */

export interface PositionPlan {
  positionId: string;
  symbol: string;
  currency: string;
  venue: string;

  /** What the user paid, and what it is worth now. */
  quantity: number;
  entryPrice: number;
  costBasis: number;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;

  /** Plan levels, with live distance from the current price. */
  stopLoss: number | null;
  stopDistancePct: number | null;
  lossIfStopped: number | null;
  takeProfit1: number | null;
  tp1DistancePct: number | null;
  profitAtTp1: number | null;
  takeProfit2: number | null;
  profitAtTp2: number | null;
  /** 0..1 progress from entry to take-profit 1. Negative when underwater. */
  progressToTp1: number | null;

  /** What to do now, from the same deterministic rules as any other signal. */
  action: SignalAction;
  actionReason: string;
  rules: RuleOutcome[];
  regime: string;
  dataQuality: DataQuality;
  /** True when a CLOSED bar has already breached the recorded stop. */
  stopBreached: boolean;
  /** True when price has reached take-profit 1. */
  targetReached: boolean;
  warnings: string[];
  holdingDays: number;
  /**
   * When the plan says to be out at the latest: entry time + the strategy's
   * evaluation horizon on the position's timeframe. Null when the position was
   * recorded without a strategy.
   */
  sellByMs: number | null;
  sellByPassed: boolean;
  dataFetchedAtMs: number | null;
  latestCandleMs: number | null;
}

/**
 * When the plan says to be out at the latest: entry time + the strategy's
 * evaluation horizon on the position's timeframe. Null without a strategy.
 */
export function positionSellByMs(position: Pick<PositionRow, 'strategy_id' | 'timeframe' | 'entry_at_ms'>): number | null {
  const strategy = STRATEGIES.find((s) => s.id === position.strategy_id);
  return strategy && isTimeframe(position.timeframe)
    ? position.entry_at_ms + strategy.evaluationHorizonBars * TIMEFRAME_MS[position.timeframe]
    : null;
}

export async function buildPositionPlan(position: PositionWithAsset): Promise<PositionPlan> {
  const asset = await getAssetById(position.asset_id);
  const warnings: string[] = [];

  const costBasis = position.entry_price * position.quantity;
  const sellBy = positionSellByMs(position);
  const base: PositionPlan = {
    positionId: position.id,
    symbol: position.symbol,
    currency: position.currency,
    venue: position.venue,
    quantity: position.quantity,
    entryPrice: position.entry_price,
    costBasis,
    currentPrice: null,
    marketValue: null,
    unrealizedPnl: null,
    unrealizedPnlPct: null,
    stopLoss: position.stop_loss,
    stopDistancePct: null,
    lossIfStopped: null,
    takeProfit1: position.take_profit_1,
    tp1DistancePct: null,
    profitAtTp1: null,
    takeProfit2: position.take_profit_2,
    profitAtTp2: null,
    progressToTp1: null,
    action: 'HOLD',
    actionReason: '',
    rules: [],
    regime: 'uncertain',
    dataQuality: 'unavailable',
    stopBreached: false,
    targetReached: false,
    warnings,
    holdingDays: Math.max(0, (Date.now() - position.entry_at_ms) / 86_400_000),
    sellByMs: sellBy,
    sellByPassed: sellBy !== null && Date.now() >= sellBy,
    dataFetchedAtMs: null,
    latestCandleMs: null,
  };

  // Static plan arithmetic works even with no market data at all.
  if (position.stop_loss !== null) {
    base.lossIfStopped = (position.stop_loss - position.entry_price) * position.quantity - (position.entry_fee ?? 0);
  }
  if (position.take_profit_1 !== null) {
    base.profitAtTp1 = (position.take_profit_1 - position.entry_price) * position.quantity - (position.entry_fee ?? 0);
  }
  if (position.take_profit_2 !== null) {
    base.profitAtTp2 = (position.take_profit_2 - position.entry_price) * position.quantity - (position.entry_fee ?? 0);
  }
  if (position.entry_fee === null) {
    warnings.push('No entry fee recorded, so profit and loss figures exclude the fee you actually paid.');
  }
  if (position.stop_loss === null) {
    warnings.push('No stop-loss recorded. Without one there is no defined point at which this trade is wrong.');
  }
  if (position.take_profit_1 === null) {
    warnings.push('No take-profit recorded, so there is no defined target to sell into.');
  }

  if (!asset) {
    base.actionReason = 'The asset for this position no longer exists in the database.';
    return base;
  }

  const warmup = Math.max(...STRATEGIES.map((s) => s.warmupBars));
  const result = await getSeries(asset, position.timeframe, { limit: warmup + 80, minBars: 50 });
  base.dataQuality = result.quality;
  base.dataFetchedAtMs = result.series?.fetchedAtMs ?? null;

  const bars = result.series ? closedOnly(result.series.candles) : [];
  const livePrice = result.series?.candles.at(-1)?.close ?? null;
  base.latestCandleMs = bars.at(-1)?.openTimeMs ?? null;

  if (livePrice === null) {
    base.actionReason =
      result.providerError ?? 'No market data is available for this asset, so the plan cannot be evaluated right now.';
    warnings.push('Live price unavailable — the figures below are based only on your recorded entry.');
    return base;
  }

  // ---- Live valuation ----
  base.currentPrice = livePrice;
  base.marketValue = livePrice * position.quantity;
  base.unrealizedPnl = (livePrice - position.entry_price) * position.quantity - (position.entry_fee ?? 0);
  base.unrealizedPnlPct = costBasis > 0 ? (base.unrealizedPnl / costBasis) * 100 : null;

  if (position.stop_loss !== null) {
    base.stopDistancePct = ((livePrice - position.stop_loss) / livePrice) * 100;
  }
  if (position.take_profit_1 !== null) {
    base.tp1DistancePct = ((position.take_profit_1 - livePrice) / livePrice) * 100;
    const span = position.take_profit_1 - position.entry_price;
    base.progressToTp1 = span > 0 ? (livePrice - position.entry_price) / span : null;
  }

  // ---- Level breaches, judged on CLOSED bars ----
  const latestClosed = bars.at(-1);
  if (latestClosed && position.stop_loss !== null && latestClosed.close < position.stop_loss) {
    base.stopBreached = true;
  }
  if (latestClosed && position.take_profit_1 !== null && latestClosed.high >= position.take_profit_1) {
    base.targetReached = true;
  }

  if (bars.length < warmup) {
    base.action = base.stopBreached ? 'SELL' : 'HOLD';
    base.actionReason = base.stopBreached
      ? `A closed bar at ${latestClosed?.close} is below your stop-loss ${position.stop_loss}. Your plan says exit.`
      : `Only ${bars.length} closed bars available; ${warmup} are needed to re-evaluate the strategy rules. Your recorded stop and target still apply.`;
    return base;
  }

  // ---- Strategy re-evaluation against the USER's actual levels ----
  const indicators = buildIndicators(bars);
  const regime = classifyRegime(bars);
  base.regime = regime.regime;

  const strategy =
    STRATEGIES.find((s) => s.id === position.strategy_id) ??
    STRATEGIES.find(
      (s) => s.assetClasses.includes(asset.assetClass) && s.timeframes.includes(position.timeframe),
    );

  if (!strategy) {
    base.action = base.stopBreached ? 'SELL' : 'HOLD';
    base.actionReason = 'No strategy covers this asset and timeframe, so only your recorded stop and target apply.';
    return base;
  }

  const output = strategy.evaluate({
    bars,
    indicators,
    regime: regime.regime,
    timeframe: position.timeframe,
    assetClass: asset.assetClass,
    // The decisive part: the strategy is told about the REAL position, and is
    // given the user's own entry, stop and target rather than the signal's.
    hasOpenPosition: true,
    openEntryPrice: position.entry_price,
    openStopLoss: position.stop_loss,
    openTarget: position.take_profit_1,
  });

  base.rules = output.rules;

  // A breached stop overrides the strategy: the plan the user committed to
  // already said to exit, and that takes precedence over a fresh opinion.
  if (base.stopBreached) {
    base.action = 'SELL';
    base.actionReason = `Your stop-loss ${position.stop_loss} was breached by a closed bar at ${latestClosed?.close}. The plan you set says exit now.`;
  } else {
    base.action = output.action === 'SELL' ? 'SELL' : 'HOLD';
    base.actionReason = output.summary;
  }

  if (result.quality !== 'ok') {
    warnings.push(
      `Data quality is "${result.quality}" — ${result.freshness?.reason ?? 'this reading may not be current'}. Verify against ${position.venue} before acting.`,
    );
  }
  if (base.targetReached && base.action !== 'SELL') {
    warnings.push('Price has already touched your first target. Consider whether to take profit.');
  }

  return base;
}

export interface PortfolioSummary {
  openCount: number;
  totalCostBasis: Record<string, number>;
  totalMarketValue: Record<string, number>;
  totalUnrealized: Record<string, number>;
  actionsNeeded: number;
  stopsBreached: number;
}

/**
 * Totals are grouped BY CURRENCY and never summed across them: adding IDR to
 * USD would require an FX rate this app does not have and must not invent.
 */
export function summarizePortfolio(plans: readonly PositionPlan[]): PortfolioSummary {
  const summary: PortfolioSummary = {
    openCount: plans.length,
    totalCostBasis: {},
    totalMarketValue: {},
    totalUnrealized: {},
    actionsNeeded: 0,
    stopsBreached: 0,
  };
  for (const p of plans) {
    summary.totalCostBasis[p.currency] = (summary.totalCostBasis[p.currency] ?? 0) + p.costBasis;
    if (p.marketValue !== null) {
      summary.totalMarketValue[p.currency] = (summary.totalMarketValue[p.currency] ?? 0) + p.marketValue;
    }
    if (p.unrealizedPnl !== null) {
      summary.totalUnrealized[p.currency] = (summary.totalUnrealized[p.currency] ?? 0) + p.unrealizedPnl;
    }
    if (p.action === 'SELL') summary.actionsNeeded++;
    if (p.stopBreached) summary.stopsBreached++;
  }
  return summary;
}
