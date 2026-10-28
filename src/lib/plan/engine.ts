import 'server-only';
import { getSeries, type SeriesResult } from '@/lib/market/service';
import { closedOnly } from '@/lib/market/normalize';
import { styleForTimeframe, TIMEFRAME_MS, type AssetRef, type Timeframe } from '@/lib/market/types';
import { refreshUniverse, type UniversePair, type UniverseSnapshot } from '@/lib/indodax/universe';
import { listPositions } from '@/lib/positions/repo';
import { getTradingSettings, usableCapital, type TradingSettings } from '@/lib/settings/trading';
import { classifyRegime } from '@/lib/signals/regime';
import { computeSignalKey, insertSignalIfNew } from '@/lib/signals/repo';
import { buildIndicators, STRATEGIES } from '@/lib/strategies';
import { at } from '@/lib/indicators';
import { latestValidations } from '@/lib/evaluation/validate';
import type { Strategy } from '@/lib/strategies/types';
import { buildTradePlan, maxEntryPrice, plannedEntryPrice } from './build';
import { trendContext } from './context';
import { buildCostModel } from './costs';
import { decide } from './decision';
import { detectPendingEntry } from './pending';
import { rankSetups, scoreSetup } from './ranking';
import {
  finishScanRun,
  listLiveSetups,
  setupKey,
  startScanRun,
  updateSetupState,
  upsertSetup,
  type PairScanStatus,
  type ScanDecision,
  type ScanSummary,
  type StoredSetup,
} from './repo';
import { evaluateState, isTerminal, type LiveQuote } from './states';
import { ENTRY_PLANS, PLAN_ENGINE_VERSION, PLAN_STRATEGY_IDS, type SetupState, type TradePlan, type ValidationLabel } from './types';

/**
 * One scan of the Indodax universe -> the decision the home screen shows.
 *
 *   1. Refresh the universe (live tickers + pair rules) and the user's settings.
 *   2. Work out capital: usable capital, cash not tied up in open positions,
 *      open-position count and today's realised loss.
 *   3. For every pair: fetch 1h, 4h and 1d closed candles (each once, forced
 *      fresh - a cached in-progress bar must never be read as a closed one),
 *      run the strategies on 1h (context 4h) and 4h (context 1d), and turn
 *      every triggered or one-step-away setup into a full plan.
 *   4. Re-check setups from earlier scans against the live quote.
 *   5. Rank the actionable ones and record the decision.
 *
 * Pages only read what this stores. Requests are paced well inside Indodax's
 * documented 180/minute.
 */

const PACE_MS = 350;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start of the current day in Indonesia (WIB, UTC+7) - when the daily loss limit resets. */
export function startOfWibDay(now: number): number {
  const WIB = 7 * 3_600_000;
  return Math.floor((now + WIB) / 86_400_000) * 86_400_000 - WIB;
}

export interface ScanResult {
  scanId: string;
  decision: ScanDecision;
  top: StoredSetup | null;
  ranked: StoredSetup[];
  summary: ScanSummary;
  universe: UniverseSnapshot | null;
  error: string | null;
}

export interface CapitalState {
  usableIdr: number;
  cashAvailableIdr: number;
  openPositions: number;
  dailyLossPercent: number;
}

export async function capitalState(settings: TradingSettings, now: number): Promise<CapitalState> {
  const usable = usableCapital(settings);
  const open = (await listPositions('open')).filter((p) => p.exchange_id === 'INDODAX');
  const committed = open.reduce((s, p) => s + p.entry_price * p.quantity, 0);
  const dayStart = startOfWibDay(now);
  const realisedToday = (await listPositions('closed'))
    .filter((p) => p.exchange_id === 'INDODAX' && (p.exit_at_ms ?? 0) >= dayStart)
    .reduce((s, p) => s + (p.realized_pnl ?? 0), 0);
  return {
    usableIdr: usable,
    cashAvailableIdr: Math.max(0, usable - committed),
    openPositions: open.length,
    dailyLossPercent: usable > 0 && realisedToday < 0 ? (-realisedToday / usable) * 100 : 0,
  };
}

/**
 * The label earned by the newest validation run of a strategy x timeframe
 * (see lib/evaluation/validate.ts). No run yet means experimental.
 */
function validationFor(labels: ReadonlyMap<string, { label: ValidationLabel }>, strategyId: string, timeframe: string): ValidationLabel {
  return labels.get(`${strategyId}|${timeframe}`)?.label ?? 'experimental';
}

function assetOf(p: UniversePair): AssetRef {
  return {
    id: p.assetId,
    symbol: p.symbol,
    displayName: p.description,
    assetClass: 'crypto',
    exchangeId: 'INDODAX',
    currency: 'IDR',
    tickSize: p.priceIncrement,
    lotSize: p.quantityIncrement,
    minNotional: p.minOrderIdr,
  };
}

function isFresh(series: SeriesResult, tf: Timeframe, now: number): boolean {
  const last = series.series ? closedOnly(series.series.candles).at(-1) : undefined;
  return series.quality === 'ok' && last !== undefined && now - last.closeTimeMs <= TIMEFRAME_MS[tf] * 1.25;
}

export async function runIndodaxScan(): Promise<ScanResult> {
  const started = Date.now();
  const scanId = await startScanRun(PLAN_ENGINE_VERSION);
  const settings = await getTradingSettings();
  const pairStatuses: PairScanStatus[] = [];
  const emptySummary = (cap: CapitalState | null, universe: UniverseSnapshot | null): ScanSummary => ({
    pairs: pairStatuses,
    stateCounts: {},
    usableCapitalIdr: cap?.usableIdr ?? usableCapital(settings),
    cashAvailableIdr: cap?.cashAvailableIdr ?? 0,
    openPositions: cap?.openPositions ?? 0,
    maxOpenPositions: settings.maxOpenPositions,
    dailyLossPercent: cap?.dailyLossPercent ?? 0,
    maxDailyLossPercent: settings.maxDailyLossPercent,
    universeGeneratedAtMs: universe?.generatedAtMs ?? null,
    durationMs: Date.now() - started,
  });

  let universe: UniverseSnapshot;
  try {
    universe = await refreshUniverse();
  } catch (err) {
    const error = `Indodax market data unavailable: ${err instanceof Error ? err.message : String(err)}`;
    const summary = emptySummary(null, null);
    await finishScanRun(scanId, { status: 'error', decision: 'DATA_UNAVAILABLE', topSetupId: null, universeSize: 0, pairsWithData: 0, summary, error });
    return { scanId, decision: 'DATA_UNAVAILABLE', top: null, ranked: [], summary, universe: null, error };
  }

  const cap = await capitalState(settings, started);
  const validations = await latestValidations();
  const quoteAt = universe.generatedAtMs;
  const strategies = PLAN_STRATEGY_IDS.map((id) => STRATEGIES.find((s) => s.id === id)).filter((s): s is Strategy => !!s);
  const seen = new Set<string>();
  const results: StoredSetup[] = [];
  let pairsWithData = 0;

  for (const pair of universe.pairs) {
    const asset = assetOf(pair);
    const quote: LiveQuote = { bid: pair.bid, ask: pair.ask, atMs: quoteAt };
    const costs = buildCostModel({
      takerFeePercent: pair.takerFeePercent,
      spreadPercent: pair.spreadPercent,
      sellTaxPercent: settings.sellTaxPercent,
      otherFeePercentPerSide: settings.otherFeePercentPerSide,
    });

    // Each distinct timeframe is fetched once: 4h serves as an entry timeframe and as 1h's context.
    const series = new Map<Timeframe, SeriesResult>();
    for (const tf of ['1h', '4h', '1d'] as const) {
      const s = await getSeries(asset, tf, { limit: 300, minBars: tf === '1d' ? 60 : 120, force: true });
      series.set(tf, s);
      if (!s.fromCache) await sleep(PACE_MS);
    }
    let anyData = false;

    for (const { timeframe, context } of ENTRY_PLANS) {
      const entrySeries = series.get(timeframe)!;
      const now = Date.now();
      if (!entrySeries.series || !isFresh(entrySeries, timeframe, now)) {
        pairStatuses.push({
          symbol: pair.symbol,
          timeframe,
          status: 'data_unavailable',
          detail: entrySeries.providerError ?? entrySeries.notes[0] ?? `data quality "${entrySeries.quality}"`,
          regime: null,
          contextUp: null,
        });
        continue;
      }
      anyData = true;
      const bars = closedOnly(entrySeries.series.candles);
      const ctxSeries = series.get(context)!;
      const ctx = trendContext(ctxSeries.series ? closedOnly(ctxSeries.series.candles) : [], context);
      const indicators = buildIndicators(bars);
      const regime = classifyRegime(bars);
      const bar = bars.at(-1)!;
      const atr = at(indicators.atr, bars.length - 1);
      let produced = false;
      const reasons: string[] = [];

      for (const strategy of strategies) {
        if (!strategy.timeframes.includes(timeframe)) continue;
        const output = strategy.evaluate({
          bars,
          indicators,
          regime: regime.regime,
          timeframe,
          assetClass: 'crypto',
          hasOpenPosition: false,
          openEntryPrice: null,
          openStopLoss: null,
          openTarget: null,
        });
        const pending =
          output.action === 'BUY' ? null : detectPendingEntry(strategy.id, output, bars, indicators, strategy.parameters);
        if ((output.action !== 'BUY' || !output.levels) && !pending) {
          reasons.push(`${strategy.id}: ${output.summary}`);
          continue;
        }
        if (atr === null) continue;

        const triggered = output.action === 'BUY' && output.levels !== null;
        const base = triggered
          ? {
              reference: bar.close,
              low: output.levels!.entryLow,
              stop: output.levels!.stopLoss,
              tp1: output.levels!.takeProfit1,
              tp2: output.levels!.takeProfit2,
            }
          : {
              reference: pending!.triggerPrice,
              low: pending!.entryLow,
              stop: pending!.stopLoss,
              tp1: pending!.takeProfit1,
              tp2: pending!.takeProfit2,
            };
        const maxEntry = maxEntryPrice({
          referenceEntry: base.reference,
          atr,
          stopLoss: base.stop,
          takeProfit1: base.tp1,
          minNetRiskReward: settings.minNetRiskReward,
          costs,
        });
        const levels = { ...base, planned: plannedEntryPrice(pair.ask, maxEntry, triggered ? null : pending!.triggerPrice) };

        const plan: TradePlan = buildTradePlan({
          assetId: pair.assetId,
          symbol: pair.symbol,
          description: pair.description,
          strategy: { id: strategy.id, version: strategy.version, name: strategy.name, horizonBars: strategy.evaluationHorizonBars },
          timeframe,
          contextTimeframe: context,
          kind: triggered ? 'triggered' : 'pending',
          signalBar: { openTimeMs: bar.openTimeMs, closeTimeMs: bar.closeTimeMs },
          referenceEntry: levels.reference,
          plannedEntry: levels.planned,
          entryLow: levels.low,
          stopLoss: levels.stop,
          takeProfit1: levels.tp1,
          takeProfit2: levels.tp2,
          trigger: triggered ? null : { price: pending!.triggerPrice, requiresVolume: pending!.requiresVolume },
          atr,
          context: ctx,
          costs,
          capital: { usableIdr: cap.usableIdr, cashAvailableIdr: cap.cashAvailableIdr },
          settings,
          pair: { quantityIncrement: pair.quantityIncrement, minOrderIdr: pair.minOrderIdr },
          rules: output.rules,
          risks: output.risks,
          invalidation: output.invalidation,
          summary: output.summary,
        });

        const { state, reason } = evaluateState(plan, quote, true, now);
        const validation = validationFor(validations, strategy.id, timeframe);
        const score = scoreSetup({
          plan,
          state,
          validation,
          volumeIdr: pair.volumeIdr,
          spreadPercent: pair.spreadPercent,
          maxSpreadPercent: settings.maxSpreadPercent,
          ask: pair.ask,
        });

        // A triggered entry is also recorded as a classic BUY signal, so the
        // existing forward evaluation keeps scoring what the engine produced.
        let signalId: string | null = null;
        if (triggered) {
          const { signal } = await insertSignalIfNew({
            signalKey: computeSignalKey({
              strategyId: strategy.id,
              strategyVersion: strategy.version,
              assetId: pair.assetId,
              timeframe,
              action: 'BUY',
              candleOpenMs: bar.openTimeMs,
            }),
            assetId: pair.assetId,
            timeframe,
            tradingStyle: styleForTimeframe(timeframe),
            strategyId: strategy.id,
            strategyVersion: strategy.version,
            action: 'BUY',
            strength: output.strength,
            candleOpenMs: bar.openTimeMs,
            dataFetchedMs: entrySeries.series.fetchedAtMs,
            priceAtSignal: bar.close,
            entryLow: output.levels!.entryLow,
            entryHigh: plan.entry.max,
            stopLoss: plan.stopLoss,
            takeProfit1: plan.takeProfit1,
            takeProfit2: plan.takeProfit2,
            riskReward: plan.outcome.netRiskReward,
            positionSize: plan.sizing.quantity,
            riskAmount: plan.sizing.lossAtStopIdr,
            regime: regime.regime,
            dataQuality: entrySeries.quality,
            reasons: { summary: output.summary, rules: output.rules },
            risks: output.risks,
            invalidation: output.invalidation,
            indicators: { atr, close: bar.close },
            newsIds: null,
          });
          signalId = signal.id;
        }

        const stored = await upsertSetup({ plan, state, reason, score, validation, scanId, signalId });
        seen.add(setupKey(plan));
        results.push(stored);
        produced = true;
      }

      pairStatuses.push({
        symbol: pair.symbol,
        timeframe,
        status: produced ? 'setup' : 'no_setup',
        detail: produced ? '' : reasons.join(' | '),
        regime: regime.regime,
        contextUp: ctx.up,
      });
    }
    if (anyData) pairsWithData++;
  }

  // Setups from earlier scans: a triggered plan stays valid through its entry
  // window, so re-check it against the live quote. A pending setup that was
  // not re-detected no longer has its conditions in place.
  const quotes = new Map(universe.pairs.map((p) => [p.assetId, { bid: p.bid, ask: p.ask, atMs: quoteAt } as LiveQuote]));
  for (const old of await listLiveSetups()) {
    if (seen.has(old.setup_key)) continue;
    const now = Date.now();
    if (old.plan.kind === 'pending') {
      await updateSetupState(old.id, 'EXPIRED', 'expired', scanId);
      continue;
    }
    const { state, reason } = evaluateState(old.plan, quotes.get(old.asset_id) ?? null, true, now);
    await updateSetupState(old.id, state, reason, scanId);
    if (!isTerminal(state)) results.push({ ...old, state, state_reason: reason });
  }

  const ranked = rankSetups(results);
  const top = ranked[0] ?? null;
  const stateCounts: Partial<Record<SetupState, number>> = {};
  for (const r of results) stateCounts[r.state] = (stateCounts[r.state] ?? 0) + 1;

  const decision = decide({
    pairsWithData,
    dailyLossPercent: cap.dailyLossPercent,
    maxDailyLossPercent: settings.maxDailyLossPercent,
    openPositions: cap.openPositions,
    maxOpenPositions: settings.maxOpenPositions,
    topState: top?.state ?? null,
  });

  const summary: ScanSummary = { ...emptySummary(cap, universe), stateCounts, durationMs: Date.now() - started };
  const unavailable = pairStatuses.filter((p) => p.status === 'data_unavailable').length;
  await finishScanRun(scanId, {
    status: unavailable > 0 ? 'partial' : 'ok',
    decision,
    topSetupId: top?.id ?? null,
    universeSize: universe.pairs.length,
    pairsWithData,
    summary,
  });

  return { scanId, decision, top, ranked, summary, universe, error: null };
}
