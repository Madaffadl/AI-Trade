import 'server-only';
import { getSetting, setSetting } from '@/lib/db/repo';
import { getMessages } from '@/lib/i18n';
import { fetchTickerAll, type IndodaxTicker } from '@/lib/indodax/api';
import { dispatchAlert } from '@/lib/notifications/dispatch';
import { buyNowKey, cancelAlert, holdingAlert, setupAlert, simAlert } from '@/lib/notifications/plan-alerts';
import { alertExists, type NewAlert } from '@/lib/notifications/repo';
import { decide } from '@/lib/plan/decision';
import { capitalState } from '@/lib/plan/engine';
import { rankSetups } from '@/lib/plan/ranking';
import { latestScanRun, listSetupsForScan, updateScanDecision, updateSetupState, type ScanDecision, type StoredSetup } from '@/lib/plan/repo';
import { evaluateState, isTerminal, MAX_SCAN_AGE_MS } from '@/lib/plan/states';
import { positionSellByMs } from '@/lib/positions/plan';
import { listPositions } from '@/lib/positions/repo';
import { getTradingSettings } from '@/lib/settings/trading';
import { simEvents } from '@/lib/sim/fills';
import { stateOf } from '@/lib/sim/repo';
import { autoSimulate, monitorSimulations } from '@/lib/sim/service';
import { MARKET_LOCK, withLock } from './lock';

/**
 * The live check: one `ticker_all` request (every pair's bid and ask) applied
 * to everything that depends on the price between two scans.
 *
 *   1. setups of the latest scan -> BUY NOW / WAIT / MISSED / INVALIDATED ...
 *      (a pending trigger is NOT confirmed here: that needs a closed candle,
 *      which only the hourly scan sees)
 *   2. the home-screen decision, re-ranked on the new states
 *   3. paper trades: fills, stops, targets, sell-by times
 *   4. auto-simulation of setups that just became BUY NOW
 *   5. holdings you recorded: stop, target 1, sell-by time
 *   6. in-app alerts for each of the above (de-duplicated by event)
 *
 * The worker runs it every minute; every scan ends with one too.
 */

const HEARTBEAT_KEY = 'monitor.lastCheck';

export interface MonitorHeartbeat {
  /** Last live check of any kind (the worker's monitor, or the end of a scan). */
  checkedAtMs: number;
  scanId: string | null;
  /** Last check by the worker's every-minute monitor: whether monitoring is actually running. */
  monitorAtMs: number | null;
}

export async function monitorHeartbeat(): Promise<MonitorHeartbeat | null> {
  return getSetting<MonitorHeartbeat | null>(HEARTBEAT_KEY, null);
}

export interface LiveCheckSummary {
  checkedAtMs: number;
  scanId: string | null;
  decision: ScanDecision | null;
  setupsChanged: number;
  simChanged: number;
  simOpened: number;
  alertsCreated: number;
}

export async function liveCheck(
  tickers: ReadonlyMap<string, IndodaxTicker>,
  options: { fromMonitor?: boolean; now?: number } = {},
): Promise<LiveCheckSummary> {
  const now = options.now ?? Date.now();
  const t = await getMessages();
  const settings = await getTradingSettings();
  const summary: LiveCheckSummary = {
    checkedAtMs: now,
    scanId: null,
    decision: null,
    setupsChanged: 0,
    simChanged: 0,
    simOpened: 0,
    alertsCreated: 0,
  };
  const send = async (alert: NewAlert | null) => {
    if (alert && (await dispatchAlert(alert)).created) summary.alertsCreated++;
  };
  const quoteOf = (symbol: string) => {
    const tk = tickers.get(symbol);
    return tk ? { bid: tk.bid, ask: tk.ask, atMs: tk.serverTimeMs ?? now } : null;
  };

  // 1-2. Setups and the decision.
  let ranked: StoredSetup[] = [];
  const scan = await latestScanRun();
  if (scan) {
    summary.scanId = scan.id;
    const candlesFresh = now - (scan.finished_at_ms ?? scan.started_at_ms) <= MAX_SCAN_AGE_MS;
    const current: StoredSetup[] = [];
    for (const s of await listSetupsForScan(scan.id)) {
      if (isTerminal(s.state)) {
        current.push(s);
        continue;
      }
      const { state, reason } = evaluateState(s.plan, quoteOf(s.plan.symbol), candlesFresh, now);
      if (state !== s.state || reason !== s.state_reason) {
        await updateSetupState(s.id, state, reason, null);
        summary.setupsChanged++;
      }
      current.push({ ...s, state, state_reason: reason });
    }
    for (const s of current) {
      if (!isTerminal(s.state)) await send(setupAlert(t, s));
      else if (await alertExists(buyNowKey(s.id))) await send(cancelAlert(t, s));
    }

    ranked = rankSetups(current);
    const cap = await capitalState(settings, now);
    const decision = decide({
      pairsWithData: scan.pairs_with_data,
      dailyLossPercent: cap.dailyLossPercent,
      maxDailyLossPercent: settings.maxDailyLossPercent,
      openPositions: cap.openPositions,
      maxOpenPositions: settings.maxOpenPositions,
      topState: ranked[0]?.state ?? null,
    });
    if (decision !== scan.decision || (ranked[0]?.id ?? null) !== scan.top_setup_id) {
      await updateScanDecision(scan.id, decision, ranked[0]?.id ?? null);
    }
    summary.decision = decision;
  }

  // 3. Paper trades.
  const sims = await monitorSimulations(tickers, now);
  summary.simChanged = sims.changed;
  for (const { trade, event } of sims.events) await send(simAlert(t, trade, event));

  // 4. Auto-simulation of what is buyable now.
  const opened = await autoSimulate(ranked, tickers);
  summary.simOpened = opened.length;
  for (const trade of opened) {
    for (const event of simEvents(null, stateOf(trade))) await send(simAlert(t, trade, event));
  }

  // 5. Holdings you recorded.
  for (const p of await listPositions('open')) {
    if (p.exchange_id !== 'INDODAX') continue;
    const q = quoteOf(p.symbol);
    if (!q) continue;
    await send(holdingAlert(t, { ...p, sellByMs: positionSellByMs(p) }, q.bid, now));
  }

  const previous = await monitorHeartbeat();
  await setSetting(HEARTBEAT_KEY, {
    checkedAtMs: now,
    scanId: summary.scanId,
    monitorAtMs: options.fromMonitor ? now : (previous?.monitorAtMs ?? null),
  } satisfies MonitorHeartbeat);
  return summary;
}

export async function fetchTickerMap(): Promise<Map<string, IndodaxTicker>> {
  return new Map((await fetchTickerAll()).tickers.map((tk) => [tk.symbol, tk]));
}

/** The worker's every-minute job. Throws JobBusyError while a scan holds the market lock. */
export async function runMonitor(): Promise<LiveCheckSummary> {
  return withLock(MARKET_LOCK, 2 * 60_000, async () => liveCheck(await fetchTickerMap(), { fromMonitor: true }));
}
