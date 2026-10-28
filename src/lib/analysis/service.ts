import 'server-only';
import { env, features } from '@/lib/config/env';
import { db } from '@/lib/db/driver';
import { newId, nowMs, providerCooldowns, recordProviderError, recordProviderOk } from '@/lib/db/repo';
import { getLocale } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n/types';
import { canGenerateSignals } from '@/lib/market/freshness';
import { closedOnly } from '@/lib/market/normalize';
import { getSeries } from '@/lib/market/service';
import type { AssetRef, Timeframe } from '@/lib/market/types';
import { styleForTimeframe } from '@/lib/market/types';
import { listArticlesForAsset, type ArticleRow } from '@/lib/news/repo';
import { aiCooldownMs, aiProviderChain, providersToTry } from '@/lib/providers/ai';
import { ProviderError } from '@/lib/providers/http';
import { classifyRegime } from '@/lib/signals/regime';
import { buildIndicators, STRATEGIES } from '@/lib/strategies';
import type { StrategyOutput } from '@/lib/strategies/types';
import { setSetupAnalysis, type StoredSetup } from '@/lib/plan/repo';
import { buildUserPrompt, SYSTEM_PROMPT, type PlanPromptContext } from './prompt';
import { parseModelJson, validateAiAnalysis, type AiAnalysis } from './schema';

/**
 * Analysis orchestration.
 *
 * Deterministic analysis ALWAYS runs. The AI layer is optional, cached, and
 * capped. Three separate guards keep costs near zero:
 *   1. AI_PROVIDER=none (or no key) -> deterministic only.
 *   2. A cached analysis younger than AI_CACHE_MINUTES is reused verbatim.
 *   3. AI_MAX_CALLS_PER_DAY caps spend even if the cache is cold.
 *
 * A page render never triggers an AI call implicitly - callers must pass
 * `allowAiCall: true`, which only the explicit "Generate AI analysis" action
 * and the scheduled job do.
 */

export interface AnalysisResult {
  runId: string;
  assetId: string;
  symbol: string;
  timeframe: Timeframe;
  tradingStyle: string;
  analysisTimeMs: number;
  latestCandleMs: number | null;
  dataFetchedMs: number | null;
  dataQuality: string;
  regime: string;
  regimeExplanation: string;
  indicators: Record<string, unknown>;
  strategies: { strategyId: string; version: string; output: StrategyOutput }[];
  articles: ArticleRow[];
  /** 'deterministic' when no model was used. */
  aiProvider: string;
  aiModel: string | null;
  aiStatus: 'ok' | 'cached' | 'skipped' | 'error';
  aiError: string | null;
  ai: AiAnalysis | null;
  notes: string[];
}

/** Longest lookback any indicator in the bundle needs (EMA 200). */
const LONGEST_INDICATOR_PERIOD = 200;

/**
 * Output budget per AI call. The JSON answer itself is ~1-2K tokens, but
 * reasoning models (Gemini 3.x, Claude Opus 5.5) spend their thinking from the
 * same budget; at 2K the answer was at risk of being cut off mid-object.
 * Providers with a tighter quota cap this further (see providers/ai).
 */
const AI_MAX_OUTPUT_TOKENS = 8_192;


export interface AnalysisOptions {
  allowAiCall?: boolean;
  force?: boolean;
  /** Commentary language; defaults to the interface language. */
  language?: Locale;
  /**
   * Explain this setup's trade plan. The model gets the plan's numbers and
   * validation label, the per-asset cache is bypassed (an explanation of a
   * different plan would not fit), and a successful run is linked to the setup.
   */
  setup?: { setup: StoredSetup; outOfSample: PlanPromptContext['outOfSample'] };
}

export function planPromptContext(setup: StoredSetup, outOfSample: PlanPromptContext['outOfSample']): PlanPromptContext {
  const p = setup.plan;
  return {
    state: setup.state,
    strategy: `${p.strategyId}@${p.strategyVersion}`,
    timeframe: p.timeframe,
    contextTimeframe: p.contextTimeframe,
    contextUp: p.context.up,
    trigger: setup.state === 'WAIT_FOR_ENTRY' && setup.state_reason === 'awaiting_trigger' ? p.trigger : null,
    entryPlanned: p.entry.planned,
    entryMax: p.entry.max,
    stopLoss: p.stopLoss,
    stopDistancePercent: p.outcome.stopDistancePercent,
    takeProfit1: p.takeProfit1,
    tp1DistancePercent: p.outcome.tp1DistancePercent,
    takeProfit2: p.takeProfit2,
    netRiskReward: p.outcome.netRiskReward,
    roundTripCostPercent: p.costs.roundTripPercent,
    amountIdr: p.sizing.notionalIdr,
    lossAtStopIdr: p.sizing.lossAtStopIdr,
    netProfitTp1Idr: p.outcome.netProfitTp1Idr,
    holdHours: Math.round(p.holding.horizonMs / 3_600_000),
    validation: setup.validation,
    outOfSample,
  };
}

export async function analyzeAsset(
  asset: AssetRef,
  timeframe: Timeframe,
  options: AnalysisOptions = {},
): Promise<AnalysisResult> {
  const analysisTimeMs = nowMs();
  const style = styleForTimeframe(timeframe);
  // Must cover the LONGEST indicator window, not just the strategy warm-up:
  // EMA200 needs 200 closed bars, so a 200-bar request would leave it
  // permanently null on the asset page.
  const warmup = Math.max(...STRATEGIES.map((s) => s.warmupBars));
  const limit = Math.max(warmup + 80, LONGEST_INDICATOR_PERIOD + 100);

  const series = await getSeries(asset, timeframe, { limit, minBars: 50 });
  const notes = [...series.notes];
  const bars = series.series ? closedOnly(series.series.candles) : [];

  const base: AnalysisResult = {
    runId: newId(),
    assetId: asset.id,
    symbol: asset.symbol,
    timeframe,
    tradingStyle: style,
    analysisTimeMs,
    latestCandleMs: bars.at(-1)?.openTimeMs ?? null,
    dataFetchedMs: series.series?.fetchedAtMs ?? null,
    dataQuality: series.quality,
    regime: 'uncertain',
    regimeExplanation: 'Not enough data to classify a regime.',
    indicators: {},
    strategies: [],
    articles: [],
    aiProvider: 'deterministic',
    aiModel: null,
    aiStatus: 'skipped',
    aiError: null,
    ai: null,
    notes,
  };

  if (bars.length < 60) {
    base.notes.push(`Only ${bars.length} closed bars available; deterministic analysis is limited.`);
    await persistRun(base, null);
    return base;
  }

  const indicators = buildIndicators(bars);
  const regime = classifyRegime(bars);
  const i = bars.length - 1;
  const pick = (s: (number | null)[]) => s[i] ?? null;

  base.regime = regime.regime;
  base.regimeExplanation = regime.explanation;
  base.indicators = {
    close: bars[i]!.close,
    ema20: pick(indicators.emaFast),
    ema50: pick(indicators.emaSlow),
    ema200: pick(indicators.emaLong),
    rsi14: pick(indicators.rsi),
    macd: pick(indicators.macdLine),
    macdSignal: pick(indicators.macdSignal),
    macdHistogram: pick(indicators.macdHistogram),
    atr14: pick(indicators.atr),
    bbUpper: pick(indicators.bollinger.upper),
    bbMiddle: pick(indicators.bollinger.middle),
    bbLower: pick(indicators.bollinger.lower),
    bbPercentB: pick(indicators.bollinger.percentB),
    relativeVolume: pick(indicators.volume.relativeVolume),
    volumeAvailable: !indicators.volume.unavailable,
    support: indicators.support,
    resistance: indicators.resistance,
  };

  base.strategies = STRATEGIES.filter(
    (s) => s.assetClasses.includes(asset.assetClass) && s.timeframes.includes(timeframe),
  ).map((s) => ({
    strategyId: s.id,
    version: s.version,
    output: s.evaluate({
      bars,
      indicators,
      regime: regime.regime,
      timeframe,
      assetClass: asset.assetClass,
      hasOpenPosition: false,
      openEntryPrice: null,
      openStopLoss: null,
      openTarget: null,
    }),
  }));

  base.articles = await listArticlesForAsset(asset.id, 6);

  // ---- Optional AI layer ----
  const flags = features();
  if (!flags.aiEnabled) {
    base.aiStatus = 'skipped';
    base.aiError =
      env().AI_PROVIDER.length === 0
        ? 'AI_PROVIDER is set to "none". Showing deterministic analysis only.'
        : 'None of the AI providers in AI_PROVIDER has an API key and model configured. Showing deterministic analysis only.';
    await persistRun(base, null);
    return base;
  }

  const cached = options.force || options.setup ? null : await findCachedRun(asset.id, timeframe);
  if (cached) {
    base.ai = cached.ai;
    base.aiStatus = 'cached';
    base.aiProvider = cached.provider;
    base.aiModel = cached.model;
    base.notes.push(
      `AI commentary reused from a cached run generated ${Math.round((analysisTimeMs - cached.startedAtMs) / 60_000)} min ago (cache window ${env().AI_CACHE_MINUTES} min).`,
    );
    return base;
  }

  if (!options.allowAiCall) {
    base.aiStatus = 'skipped';
    base.aiError = 'No cached AI commentary. Use "Generate AI analysis" to request one (this calls the AI provider).';
    await persistRun(base, null);
    return base;
  }

  if (await dailyCallsExceeded()) {
    base.aiStatus = 'skipped';
    base.aiError = `Daily AI call limit (AI_MAX_CALLS_PER_DAY=${env().AI_MAX_CALLS_PER_DAY}) reached. Deterministic analysis is unaffected.`;
    await persistRun(base, null);
    return base;
  }

  // Degraded data gets deterministic analysis but no AI narrative, so the app
  // never produces confident prose about numbers it does not trust.
  if (!canGenerateSignals(series.quality)) {
    base.aiStatus = 'skipped';
    base.aiError = `Data quality is "${series.quality}"; AI commentary is withheld to avoid narrating unreliable data.`;
    await persistRun(base, null);
    return base;
  }

  const { prompt, allowedUrls } = buildUserPrompt({
    language: options.language ?? (await getLocale()),
    symbol: asset.symbol,
    displayName: asset.displayName,
    exchangeId: asset.exchangeId,
    currency: asset.currency,
    timeframe,
    tradingStyle: style,
    regime: regime.regime,
    regimeExplanation: regime.explanation,
    analysisTimeMs,
    latestCandleMs: bars[i]!.openTimeMs,
    dataFetchedMs: series.series!.fetchedAtMs,
    dataQuality: series.quality,
    providerNotes: notes,
    indicators: base.indicators,
    strategyOutputs: base.strategies,
    articles: base.articles,
    plan: options.setup ? planPromptContext(options.setup.setup, options.setup.outOfSample) : undefined,
  });

  // Walk the fallback chain. A provider that errors, returns malformed JSON,
  // or fails validation hands over to the next one; the first valid answer
  // wins. Every failure is kept so the final message says what went wrong.
  const failures: string[] = [];
  const { attempt, skipped } = providersToTry(
    aiProviderChain().filter((p) => p.isConfigured()),
    await providerCooldowns('ai'),
    nowMs(),
  );
  for (const s of skipped) {
    failures.push(`${s.key}: skipped, cooling down until ${new Date(s.untilMs).toISOString()} after a recent failure`);
  }
  for (const provider of attempt) {
    try {
      const response = await provider.complete({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: prompt,
        maxTokens: AI_MAX_OUTPUT_TOKENS,
      });
      await recordProviderOk(provider.key, 'ai');

      const parsed = parseModelJson(response.text);
      if (!parsed.ok) {
        failures.push(`${provider.key}: did not return valid JSON (${parsed.error})`);
        continue;
      }
      const validation = validateAiAnalysis(parsed.value, allowedUrls);
      if (!validation.ok) {
        // A response that invents a URL or promises profit is discarded, not
        // shown with a warning.
        failures.push(`${provider.key}: rejected by schema validation (${validation.errors.join('; ')})`);
        continue;
      }
      base.ai = validation.analysis;
      base.aiStatus = 'ok';
      base.aiProvider = response.provider;
      base.aiModel = response.model;
      if (failures.length > 0) {
        base.notes.push(`AI commentary came from fallback ${provider.key} after: ${failures.join(' | ')}`);
      }
      break;
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError(String(err), 'network');
      const cooldown = aiCooldownMs(pe);
      await recordProviderError(provider.key, 'ai', pe.message, cooldown === undefined ? undefined : nowMs() + cooldown);
      failures.push(`${provider.key} (${pe.kind}): ${pe.message}`);
    }
  }

  if (!base.ai) {
    base.aiStatus = 'error';
    base.aiError = `Every configured AI provider failed: ${failures.join(' | ')}. Deterministic analysis is unaffected.`;
  }

  await persistRun(base, base.ai);
  if (base.ai && options.setup) await setSetupAnalysis(options.setup.setup.id, base.runId);
  return base;
}

async function persistRun(result: AnalysisResult, ai: AiAnalysis | null): Promise<void> {
  const d = await db();
  await d.run(
    `INSERT INTO analysis_runs
       (id, asset_id, timeframe, trading_style, started_at_ms, finished_at_ms, latest_candle_ms,
        ai_provider, ai_model, ai_status, ai_error, analysis_json, strategy_version, data_quality)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      result.runId,
      result.assetId,
      result.timeframe,
      result.tradingStyle,
      result.analysisTimeMs,
      nowMs(),
      result.latestCandleMs,
      result.aiProvider,
      result.aiModel,
      result.aiStatus,
      result.aiError,
      ai ? JSON.stringify(ai) : null,
      result.strategies.map((s) => `${s.strategyId}@${s.version}`).join(',') || 'none',
      result.dataQuality,
    ],
  );
}

/**
 * The panel's first render: cached AI commentary if any, read from the
 * database only. Never calls a market-data or AI provider.
 */
export async function cachedAnalysisForPanel(
  assetId: string,
  timeframe: Timeframe,
): Promise<Pick<AnalysisResult, 'aiStatus' | 'aiProvider' | 'aiModel' | 'aiError' | 'ai'>> {
  const cached = await findCachedRun(assetId, timeframe);
  return cached
    ? { aiStatus: 'cached', aiProvider: cached.provider, aiModel: cached.model, aiError: null, ai: cached.ai }
    : { aiStatus: 'skipped', aiProvider: 'deterministic', aiModel: null, aiError: null, ai: null };
}

/**
 * Commentary for a setup's page: the run written for this setup if there is
 * one (the worker explains the top setups), otherwise the asset's cached run.
 * Database only.
 */
export async function analysisForSetup(
  setup: Pick<StoredSetup, 'analysis_run_id' | 'asset_id' | 'timeframe'>,
): Promise<Pick<AnalysisResult, 'aiStatus' | 'aiProvider' | 'aiModel' | 'aiError' | 'ai'> & { generatedAtMs: number | null }> {
  if (setup.analysis_run_id) {
    const run = await analysisRun(setup.analysis_run_id);
    if (run) return { aiStatus: 'cached', aiProvider: run.provider, aiModel: run.model, aiError: null, ai: run.ai, generatedAtMs: run.startedAtMs };
  }
  return { ...(await cachedAnalysisForPanel(setup.asset_id, setup.timeframe as Timeframe)), generatedAtMs: null };
}

/** A successful AI run by id. */
export async function analysisRun(
  id: string,
): Promise<{ ai: AiAnalysis; provider: string; model: string | null; startedAtMs: number } | null> {
  const d = await db();
  const row = await d.get<{ analysis_json: string; ai_provider: string; ai_model: string | null; started_at_ms: number }>(
    `SELECT analysis_json, ai_provider, ai_model, started_at_ms FROM analysis_runs
      WHERE id = ? AND ai_status = 'ok' AND analysis_json IS NOT NULL`,
    [id],
  );
  if (!row) return null;
  try {
    return { ai: JSON.parse(row.analysis_json) as AiAnalysis, provider: row.ai_provider, model: row.ai_model, startedAtMs: row.started_at_ms };
  } catch {
    return null;
  }
}

async function findCachedRun(
  assetId: string,
  timeframe: Timeframe,
): Promise<{ ai: AiAnalysis; provider: string; model: string | null; startedAtMs: number } | null> {
  const d = await db();
  const cutoff = nowMs() - env().AI_CACHE_MINUTES * 60_000;
  const row = await d.get<{ analysis_json: string; ai_provider: string; ai_model: string | null; started_at_ms: number }>(
    `SELECT analysis_json, ai_provider, ai_model, started_at_ms FROM analysis_runs
     WHERE asset_id = ? AND timeframe = ? AND ai_status = 'ok' AND analysis_json IS NOT NULL AND started_at_ms >= ?
     ORDER BY started_at_ms DESC LIMIT 1`,
    [assetId, timeframe, cutoff],
  );
  if (!row) return null;
  try {
    return {
      ai: JSON.parse(row.analysis_json) as AiAnalysis,
      provider: row.ai_provider,
      model: row.ai_model,
      startedAtMs: row.started_at_ms,
    };
  } catch {
    return null;
  }
}

async function dailyCallsExceeded(): Promise<boolean> {
  const d = await db();
  const since = nowMs() - 24 * 3_600_000;
  const row = await d.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM analysis_runs WHERE started_at_ms >= ? AND ai_status IN ('ok','error')`,
    [since],
  );
  return Number(row?.n ?? 0) >= env().AI_MAX_CALLS_PER_DAY;
}

export async function listRecentAnalyses(assetId: string, limit = 5) {
  const d = await db();
  return d.all<{ id: string; timeframe: string; started_at_ms: number; ai_status: string; ai_provider: string; ai_error: string | null }>(
    `SELECT id, timeframe, started_at_ms, ai_status, ai_provider, ai_error FROM analysis_runs
     WHERE asset_id = ? ORDER BY started_at_ms DESC LIMIT ?`,
    [assetId, limit],
  );
}
