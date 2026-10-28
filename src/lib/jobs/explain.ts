import 'server-only';
import { analyzeAsset } from '@/lib/analysis/service';
import { env, features } from '@/lib/config/env';
import { getAssetById } from '@/lib/db/repo';
import { outOfSampleFor } from '@/lib/evaluation/validate';
import type { Timeframe } from '@/lib/market/types';
import { rankSetups } from '@/lib/plan/ranking';
import { latestScanRun, listSetupsForScan, reusableAnalysisRun, setSetupAnalysis } from '@/lib/plan/repo';

/**
 * AI commentary for the best setups of the latest scan, written by the worker
 * so a page never waits on (or pays for) a model call.
 *
 * Rate-aware by construction: at most `max` setups per scan, at least
 * `gapMs` between two calls (Groq's free tier allows ~1,000 output tokens a
 * minute), a setup that already has commentary is skipped, and an equivalent
 * setup explained within the AI cache window (a pending setup is re-created
 * every candle) reuses that explanation. AI_MAX_CALLS_PER_DAY still applies.
 */

export const AI_CALL_GAP_MS = 70_000;

export interface ExplainSummary {
  explained: string[];
  reused: string[];
  failed: string[];
  skipped: 'ai_disabled' | 'no_scan' | null;
}

export async function explainTopSetups(
  options: { max?: number; gapMs?: number; shouldStop?: () => boolean } = {},
): Promise<ExplainSummary> {
  const out: ExplainSummary = { explained: [], reused: [], failed: [], skipped: null };
  if (!features().aiEnabled) return { ...out, skipped: 'ai_disabled' };
  const scan = await latestScanRun();
  if (!scan) return { ...out, skipped: 'no_scan' };

  const top = rankSetups(await listSetupsForScan(scan.id)).slice(0, options.max ?? 2);
  const since = Date.now() - env().AI_CACHE_MINUTES * 60_000;
  let called = false;
  for (const s of top) {
    if (options.shouldStop?.()) break;
    const label = `${s.plan.symbol} ${s.timeframe}`;
    if (s.analysis_run_id) continue;
    const reuse = await reusableAnalysisRun(s, since);
    if (reuse) {
      await setSetupAnalysis(s.id, reuse);
      out.reused.push(label);
      continue;
    }
    const asset = await getAssetById(s.asset_id);
    if (!asset) continue;
    if (called) await new Promise((r) => setTimeout(r, options.gapMs ?? AI_CALL_GAP_MS));
    called = true;
    const r = await analyzeAsset(asset, s.timeframe as Timeframe, {
      allowAiCall: true,
      setup: { setup: s, outOfSample: await outOfSampleFor(s.strategy_id, s.timeframe) },
    });
    if (r.aiStatus === 'ok') out.explained.push(`${label} (${r.aiProvider}/${r.aiModel ?? '?'})`);
    else out.failed.push(`${label}: ${r.aiError ?? r.aiStatus}`);
  }
  return out;
}
