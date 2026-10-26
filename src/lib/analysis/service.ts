import 'server-only';
import { env, features } from '@/lib/config/env';
import { db } from '@/lib/db/driver';
import { newId, nowMs, recordProviderError, recordProviderOk } from '@/lib/db/repo';
import { canGenerateSignals } from '@/lib/market/freshness';
import { closedOnly } from '@/lib/market/normalize';
import { getSeries } from '@/lib/market/service';
import type { AssetRef, Timeframe } from '@/lib/market/types';
import { styleForTimeframe } from '@/lib/market/types';
import { listArticlesForAsset, type ArticleRow } from '@/lib/news/repo';
import { aiProvider } from '@/lib/providers/ai';
import { ProviderError } from '@/lib/providers/http';
import { classifyRegime } from '@/lib/signals/regime';
import { buildIndicators, STRATEGIES } from '@/lib/strategies';
import type { StrategyOutput } from '@/lib/strategies/types';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt';
import { validateAiAnalysis, type AiAnalysis } from './schema';

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

export interface AnalysisOptions {
  allowAiCall?: boolean;
  force?: boolean;
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
      env().AI_PROVIDER === 'none'
        ? 'AI_PROVIDER is set to "none". Showing deterministic analysis only.'
        : 'No API key is configured for the selected AI provider. Showing deterministic analysis only.';
    await persistRun(base, null);
    return base;
  }

  const cached = options.force ? null : await findCachedRun(asset.id, timeframe);
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

  const provider = aiProvider()!;
  const { prompt, allowedUrls } = buildUserPrompt({
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
  });

  try {
    const response = await provider.complete({ systemPrompt: SYSTEM_PROMPT, userPrompt: prompt, maxTokens: 2000 });
    await recordProviderOk(provider.id, 'ai');

    const parsed = safeJson(response.text);
    if (!parsed.ok) {
      base.aiStatus = 'error';
      base.aiError = `Model did not return valid JSON: ${parsed.error}`;
    } else {
      const validation = validateAiAnalysis(parsed.value, allowedUrls);
      if (!validation.ok) {
        // A response that invents a URL or promises profit is discarded, not
        // shown with a warning.
        base.aiStatus = 'error';
        base.aiError = `AI response rejected by schema validation: ${validation.errors.join('; ')}`;
      } else {
        base.ai = validation.analysis;
        base.aiStatus = 'ok';
        base.aiProvider = response.provider;
        base.aiModel = response.model;
      }
    }
  } catch (err) {
    const pe = err instanceof ProviderError ? err : new ProviderError(String(err), 'network');
    await recordProviderError(provider.id, 'ai', pe.message);
    base.aiStatus = 'error';
    base.aiError = `AI provider failed (${pe.kind}): ${pe.message}. Deterministic analysis is unaffected.`;
  }

  await persistRun(base, base.ai);
  return base;
}

function safeJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
