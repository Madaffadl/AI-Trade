import 'server-only';
import { finishJob, startJob } from '@/lib/db/repo';
import { formatIdrSigned } from '@/lib/format';
import { getMessages } from '@/lib/i18n';
import { dispatchAlert } from '@/lib/notifications/dispatch';
import { runIndodaxScan, type ScanResult } from '@/lib/plan/engine';
import type { ScanDecision } from '@/lib/plan/repo';
import { listActiveActionable, updateSignalStatus } from '@/lib/signals/repo';
import { MARKET_LOCK, withLock } from './lock';
import { fetchTickerMap, liveCheck } from './monitor';

/**
 * One refresh cycle, holding the market lock so it never overlaps the live
 * monitor or another scan (JobBusyError if one is running):
 *   1. an Indodax scan (the home-screen decision),
 *   2. the live check on a fresh ticker snapshot: setup states, decision,
 *      paper trades, auto-simulation, holdings, alerts (see monitor.ts),
 *   3. the strategy's exit signal for each holding you recorded,
 *   4. expiry of signals whose horizon passed long ago.
 */

export interface RefreshSummary {
  jobId: string;
  startedAtMs: number;
  finishedAtMs: number;
  scanId: string | null;
  decision: ScanDecision | null;
  setups: number;
  simUpdated: number;
  simOpened: number;
  alertsCreated: number;
  signalsExpired: number;
  error: string | null;
}

/** A scan holds the lock for well under a minute; this only matters if the process dies mid-scan. */
const SCAN_LOCK_TTL_MS = 5 * 60_000;

export async function runRefresh(options: { waitMs?: number } = {}): Promise<RefreshSummary & { scan: ScanResult | null }> {
  return withLock(MARKET_LOCK, SCAN_LOCK_TTL_MS, refreshCycle, options.waitMs ?? 0);
}

async function refreshCycle(): Promise<RefreshSummary & { scan: ScanResult | null }> {
  const jobId = await startJob('refresh');
  const summary: RefreshSummary = {
    jobId,
    startedAtMs: Date.now(),
    finishedAtMs: 0,
    scanId: null,
    decision: null,
    setups: 0,
    simUpdated: 0,
    simOpened: 0,
    alertsCreated: 0,
    signalsExpired: 0,
    error: null,
  };

  try {
    const scan = await runIndodaxScan();
    summary.scanId = scan.scanId;
    summary.decision = scan.decision;
    summary.setups = Object.values(scan.summary.stateCounts).reduce((a, b) => a + (b ?? 0), 0);
    summary.error = scan.error;

    // One ticker snapshot for every pair, including pairs that left the scan
    // universe while a simulation or holding on them is still open.
    try {
      const live = await liveCheck(await fetchTickerMap());
      summary.decision = live.decision ?? summary.decision;
      summary.simUpdated = live.simChanged;
      summary.simOpened = live.simOpened;
      summary.alertsCreated += live.alertsCreated;
    } catch (err) {
      summary.error = [summary.error, `live check failed: ${err instanceof Error ? err.message : String(err)}`]
        .filter(Boolean)
        .join(' | ');
    }

    summary.alertsCreated += await reviewOpenPositions();
    summary.signalsExpired += await expireStaleSignals();

    summary.finishedAtMs = Date.now();
    await finishJob(jobId, summary.error ? 'partial' : 'ok', summary);
    return { ...summary, scan };
  } catch (err) {
    summary.finishedAtMs = Date.now();
    await finishJob(jobId, 'error', summary, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * The strategy's own exit signal for every holding you recorded (for example
 * "close fell below EMA50"). It needs closed candles, so it runs with the
 * scan; stop, target and sell-by time are checked every minute against the
 * live bid by the monitor.
 *
 * Positions are NEVER closed automatically: the app cannot know whether you
 * sold at the exchange. It alerts, and you record the actual fill.
 */
async function reviewOpenPositions(): Promise<number> {
  const { listPositions } = await import('@/lib/positions/repo');
  const { buildPositionPlan } = await import('@/lib/positions/plan');
  const t = await getMessages();

  let created = 0;
  for (const position of await listPositions('open')) {
    try {
      const plan = await buildPositionPlan(position);
      if (plan.action !== 'SELL' || plan.stopBreached) continue;
      const sent = await dispatchAlert({
        // Keyed to the bar that produced it, so an unchanged signal alerts once.
        dedupeKey: `position_sell:${position.id}:${plan.latestCandleMs ?? 0}`,
        kind: 'position',
        severity: 'warning',
        title: t.notify.posExitTitle(position.display_name || position.symbol),
        body: t.notify.posExitBody(plan.actionReason, formatIdrSigned(plan.unrealizedPnl)),
        assetId: position.asset_id,
        payload: { positionId: position.id },
      });
      if (sent.created) created++;
    } catch {
      // One bad position must never abort the whole refresh.
      continue;
    }
  }
  return created;
}

/**
 * Expire active signals whose evaluation horizon has long passed, so the feed
 * does not accumulate stale "active" setups forever.
 */
async function expireStaleSignals(): Promise<number> {
  const { STRATEGIES } = await import('@/lib/strategies');
  const { TIMEFRAME_MS } = await import('@/lib/market/types');
  const active = await listActiveActionable();
  let expired = 0;
  const now = Date.now();

  for (const s of active) {
    const strategy = STRATEGIES.find((x) => x.id === s.strategy_id);
    if (!strategy) continue;
    const horizonMs = strategy.evaluationHorizonBars * TIMEFRAME_MS[s.timeframe];
    // 3x the horizon is a generous ceiling: well past the point where the
    // original thesis could still be live.
    if (now - s.generated_at_ms > horizonMs * 3) {
      await updateSignalStatus(s.id, 'expired');
      expired++;
    }
  }
  return expired;
}
