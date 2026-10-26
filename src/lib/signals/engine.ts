import 'server-only';
import { riskDefaults } from '@/lib/config/env';
import { getAssetById } from '@/lib/db/repo';
import { canGenerateSignals } from '@/lib/market/freshness';
import { closedOnly } from '@/lib/market/normalize';
import { getSeries } from '@/lib/market/service';
import type { AssetRef, SignalAction, Timeframe, TradingStyle } from '@/lib/market/types';
import { styleForTimeframe } from '@/lib/market/types';
import { buildIndicators, STRATEGIES } from '@/lib/strategies';
import type { Strategy, StrategyOutput } from '@/lib/strategies/types';
import { classifyRegime } from './regime';
import { computeRisk, defaultCostAssumptions } from './risk';
import {
  computeSignalKey,
  findOpenPosition,
  insertSignalIfNew,
  updateSignalStatus,
  type SignalRecord,
} from './repo';
import { findOpenPositionForAsset } from '@/lib/positions/repo';

/**
 * Signal engine.
 *
 * Pipeline per (asset, timeframe):
 *   1. Fetch/serve candles via the market service.
 *   2. REFUSE to continue unless data quality is 'ok' - degraded data produces
 *      no signal at all, rather than a low-confidence one.
 *   3. Compute indicators and regime once.
 *   4. Run each eligible strategy on CLOSED bars only.
 *   5. Size the position deterministically.
 *   6. Persist with a deterministic key so repeat runs don't duplicate.
 *
 * The engine performs no AI calls. AI commentary is layered on afterwards and
 * can never change the action, levels, or numbers computed here.
 */

export interface EngineResult {
  assetId: string;
  symbol: string;
  timeframe: Timeframe;
  regime: string;
  dataQuality: string;
  skipped: boolean;
  skipReason: string | null;
  outcomes: {
    strategyId: string;
    strategyVersion: string;
    action: SignalAction;
    strength: string;
    created: boolean;
    signalId: string | null;
    summary: string;
  }[];
  invalidated: { signalId: string; reason: string }[];
}

export interface EngineOptions {
  force?: boolean;
  strategyIds?: string[];
  /** Risk inputs; defaults come from environment configuration. */
  accountEquity?: number;
  riskPercentPerTrade?: number;
}

export async function runEngineForAsset(
  asset: AssetRef,
  timeframe: Timeframe,
  options: EngineOptions = {},
): Promise<EngineResult> {
  const style: TradingStyle = styleForTimeframe(timeframe);
  const base: EngineResult = {
    assetId: asset.id,
    symbol: asset.symbol,
    timeframe,
    regime: 'uncertain',
    dataQuality: 'unavailable',
    skipped: true,
    skipReason: null,
    outcomes: [],
    invalidated: [],
  };

  const strategies = STRATEGIES.filter(
    (s) =>
      (!options.strategyIds || options.strategyIds.includes(s.id)) &&
      s.assetClasses.includes(asset.assetClass) &&
      s.timeframes.includes(timeframe),
  );
  if (strategies.length === 0) {
    return { ...base, skipReason: `No strategy is configured for ${asset.assetClass} on the ${timeframe} timeframe.` };
  }

  const warmup = Math.max(...strategies.map((s) => s.warmupBars));
  const result = await getSeries(asset, timeframe, {
    limit: Math.max(warmup + 80, 300),
    minBars: warmup,
    force: options.force,
  });

  base.dataQuality = result.quality;

  if (!result.series) {
    return { ...base, skipReason: result.providerError ?? 'No market data available.' };
  }

  const bars = closedOnly(result.series.candles);

  // Hard gate: anything other than 'ok' suppresses signal generation. Stale,
  // delayed, insufficient and invalid data all stop here.
  if (!canGenerateSignals(result.quality)) {
    return {
      ...base,
      skipReason: `Data quality is "${result.quality}" - ${result.freshness?.reason ?? 'not usable for new signals'}.`,
    };
  }
  if (bars.length < warmup) {
    return {
      ...base,
      skipReason: `Only ${bars.length} closed bars available; ${warmup} required for the enabled strategies.`,
    };
  }

  const indicators = buildIndicators(bars);
  const regimeResult = classifyRegime(bars);
  base.regime = regimeResult.regime;
  base.skipped = false;

  const latest = bars.at(-1)!;
  const risk = riskDefaults();
  const equity = options.accountEquity ?? risk.accountEquity;
  const riskPct = options.riskPercentPerTrade ?? risk.riskPercentPerTrade;
  const costs = defaultCostAssumptions(asset.assetClass);

  const outcomes: EngineResult['outcomes'] = [];
  const invalidated: EngineResult['invalidated'] = [];

  // A REAL recorded holding outranks the signal-derived proxy: if the user
  // actually owns the asset, exit rules must be judged against the price they
  // actually paid, not against the theoretical entry of an earlier signal.
  const realPosition = await findOpenPositionForAsset(asset.id);

  for (const strategy of strategies) {
    const signalProxy = await findOpenPosition(asset.id, strategy.id, timeframe);
    const open = realPosition
      ? ({
          id: signalProxy?.id ?? `position:${realPosition.id}`,
          price_at_signal: realPosition.entry_price,
          stop_loss: realPosition.stop_loss,
          take_profit_1: realPosition.take_profit_1,
        } as Pick<SignalRecord, 'id' | 'price_at_signal' | 'stop_loss' | 'take_profit_1'> as SignalRecord)
      : signalProxy;

    // Invalidate an open SIGNAL whose stop was breached by a CLOSED bar before
    // asking the strategy for a new decision. Real positions are deliberately
    // excluded here: they are never auto-closed, because only the user knows
    // whether they actually sold. They raise an alert instead.
    if (!realPosition && open && open.stop_loss !== null && latest.close < open.stop_loss) {
      await updateSignalStatus(open.id, 'invalidated');
      invalidated.push({
        signalId: open.id,
        reason: `Closed bar at ${latest.close} fell below the stop-loss ${open.stop_loss}.`,
      });
    }

    const stillOpen = open && !invalidated.some((i) => i.signalId === open.id) ? open : null;

    const output = strategy.evaluate({
      bars,
      indicators,
      regime: regimeResult.regime,
      timeframe,
      assetClass: asset.assetClass,
      hasOpenPosition: stillOpen !== null,
      openEntryPrice: stillOpen?.price_at_signal ?? null,
      openStopLoss: stillOpen?.stop_loss ?? null,
      openTarget: stillOpen?.take_profit_1 ?? null,
    });

    const persisted = await persistOutcome({
      asset,
      timeframe,
      style,
      strategy,
      output,
      regime: regimeResult.regime,
      dataQuality: result.quality,
      latestCandleOpenMs: latest.openTimeMs,
      dataFetchedMs: result.series.fetchedAtMs,
      price: latest.close,
      indicatorsSnapshot: snapshotIndicators(indicators, bars.length - 1, regimeResult),
      equity,
      riskPct,
      costs,
    });

    // A SELL closes the SIGNAL it exits. A real position is only closed when
    // the user records the actual sale, because the app cannot know whether
    // they executed it.
    if (output.action === 'SELL' && stillOpen && !realPosition) {
      await updateSignalStatus(stillOpen.id, 'closed');
    }

    outcomes.push({
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      action: output.action,
      strength: output.strength,
      created: persisted.created,
      signalId: persisted.signal?.id ?? null,
      summary: output.summary,
    });
  }

  return { ...base, outcomes, invalidated };
}

async function persistOutcome(ctx: {
  asset: AssetRef;
  timeframe: Timeframe;
  style: TradingStyle;
  strategy: Strategy;
  output: StrategyOutput;
  regime: string;
  dataQuality: string;
  latestCandleOpenMs: number;
  dataFetchedMs: number;
  price: number;
  indicatorsSnapshot: Record<string, unknown>;
  equity: number;
  riskPct: number;
  costs: { feeBps: number; slippageBps: number };
}): Promise<{ created: boolean; signal: SignalRecord | null }> {
  const { output, strategy, asset } = ctx;

  // HOLD and WAIT are states, not events. Persisting one row per refresh would
  // flood the database and the feed with non-events, so only actionable
  // transitions (BUY/SELL) are stored.
  if (output.action === 'HOLD' || output.action === 'WAIT') {
    return { created: false, signal: null };
  }

  let riskReward: number | null = null;
  let positionSize: number | null = null;
  let riskAmount: number | null = null;

  if (output.action === 'BUY' && output.levels) {
    const r = computeRisk({
      entry: ctx.price,
      stop: output.levels.stopLoss,
      targets: [output.levels.takeProfit1, ...(output.levels.takeProfit2 ? [output.levels.takeProfit2] : [])],
      accountEquity: ctx.equity,
      riskPercentPerTrade: ctx.riskPct,
      feeBps: ctx.costs.feeBps,
      slippageBps: ctx.costs.slippageBps,
      asset,
      direction: 'long',
    });
    riskReward = r.riskRewardNet;
    positionSize = r.positionSize;
    riskAmount = r.riskAmount;
  }

  const signalKey = computeSignalKey({
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    assetId: asset.id,
    timeframe: ctx.timeframe,
    action: output.action,
    candleOpenMs: ctx.latestCandleOpenMs,
  });

  const { created, signal } = await insertSignalIfNew({
    signalKey,
    assetId: asset.id,
    timeframe: ctx.timeframe,
    tradingStyle: ctx.style,
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    action: output.action,
    strength: output.strength,
    candleOpenMs: ctx.latestCandleOpenMs,
    dataFetchedMs: ctx.dataFetchedMs,
    priceAtSignal: ctx.price,
    entryLow: output.levels?.entryLow ?? null,
    entryHigh: output.levels?.entryHigh ?? null,
    stopLoss: output.levels?.stopLoss ?? null,
    takeProfit1: output.levels?.takeProfit1 ?? null,
    takeProfit2: output.levels?.takeProfit2 ?? null,
    riskReward,
    positionSize,
    riskAmount,
    regime: ctx.regime,
    dataQuality: ctx.dataQuality,
    reasons: { summary: output.summary, rules: output.rules },
    risks: output.risks,
    invalidation: output.invalidation,
    indicators: ctx.indicatorsSnapshot,
    newsIds: null,
  });

  return { created, signal };
}

function snapshotIndicators(
  ind: ReturnType<typeof buildIndicators>,
  i: number,
  regime: ReturnType<typeof classifyRegime>,
): Record<string, unknown> {
  const pick = (s: (number | null)[]) => s[i] ?? null;
  return {
    close: ind.closes[i] ?? null,
    ema20: pick(ind.emaFast),
    ema50: pick(ind.emaSlow),
    ema200: pick(ind.emaLong),
    rsi14: pick(ind.rsi),
    macd: pick(ind.macdLine),
    macdSignal: pick(ind.macdSignal),
    macdHistogram: pick(ind.macdHistogram),
    atr14: pick(ind.atr),
    bbUpper: pick(ind.bollinger.upper),
    bbMiddle: pick(ind.bollinger.middle),
    bbLower: pick(ind.bollinger.lower),
    bbPercentB: pick(ind.bollinger.percentB),
    relativeVolume: pick(ind.volume.relativeVolume),
    volumeAvailable: !ind.volume.unavailable,
    donchianUpper: pick(ind.donchianUpper),
    donchianLower: pick(ind.donchianLower),
    support: ind.support,
    resistance: ind.resistance,
    regimeEvidence: regime.evidence,
  };
}

/** Convenience wrapper used by API routes that only have an asset id. */
export async function runEngineForAssetId(
  assetId: string,
  timeframe: Timeframe,
  options: EngineOptions = {},
): Promise<EngineResult | null> {
  const asset = await getAssetById(assetId);
  if (!asset) return null;
  return runEngineForAsset(asset, timeframe, options);
}
