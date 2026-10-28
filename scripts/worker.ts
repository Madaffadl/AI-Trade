import './_bootstrap';
import { db } from '../src/lib/db/driver';
import { finishJob, startJob } from '../src/lib/db/repo';
import { latestValidations, runValidation } from '../src/lib/evaluation/validate';
import { evaluateStoredSignals } from '../src/lib/evaluation/forward';
import { explainTopSetups } from '../src/lib/jobs/explain';
import { JobBusyError, releaseHeldLocks } from '../src/lib/jobs/lock';
import { runMonitor } from '../src/lib/jobs/monitor';
import { runRefresh } from '../src/lib/jobs/refresh';
import { intervalDue, scanDue } from '../src/lib/jobs/schedule';
import { ingestNews } from '../src/lib/news/ingest';
import { latestScanRun } from '../src/lib/plan/repo';

/**
 * Local scheduler: a plain long-running Node process (no cron daemon, no
 * queue). Keep it running next to the app - `npm run dev:all` starts both.
 *
 *   market lane, every minute, one job at a time:
 *     - the scan, hourly, 90 s after the candle close (and at start-up if the
 *       last one is older than the current hour)
 *     - otherwise the live monitor: one ticker_all request -> setup states,
 *       decision, paper trades, your holdings, alerts
 *     - the strategy validation, once a day
 *   ai lane: commentary for the top setups after each scan (calls spaced
 *     70 s apart, so it never holds up the monitor)
 *   background lane: news every 30 min, signal evaluation every 60 min
 *
 * A lane that is still busy when its next minute comes is skipped, never
 * queued. The scan and the monitor also take a database lock, so the
 * "Refresh now" button in the app cannot run at the same time.
 */

const MINUTE = 60_000;
const SCAN_OFFSET_MS = Number(process.env.WORKER_SCAN_OFFSET_SECONDS ?? 90) * 1000;
const NEWS_MS = Number(process.env.WORKER_NEWS_MINUTES ?? 30) * MINUTE;
const EVALUATE_MS = Number(process.env.WORKER_EVALUATE_MINUTES ?? 60) * MINUTE;
const VALIDATE_MS = Number(process.env.WORKER_VALIDATE_HOURS ?? 24) * 60 * MINUTE;
const AI_SETUPS = Number(process.env.WORKER_AI_SETUPS ?? 2);

const wib = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(11, 19);
const log = (lane: string, msg: string) => console.log(`[${wib()} WIB] ${lane.padEnd(8)} ${msg}`);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

let shuttingDown = false;

/** Runs one job at a time; a call while busy is dropped. */
class Lane {
  busy = false;
  constructor(readonly name: string) {}
  run(job: () => Promise<void>): void {
    if (this.busy || shuttingDown) return;
    this.busy = true;
    job()
      .catch((err) => log(this.name, `FAILED: ${errText(err)}`)) // a failing job never kills the worker
      .finally(() => {
        this.busy = false;
      });
  }
}

const market = new Lane('market');
const ai = new Lane('ai');
const background = new Lane('bg');

const last = { news: null as number | null, evaluate: null as number | null, monitorLogMs: 0 };

async function marketJob(): Promise<void> {
  const now = Date.now();
  const scan = await latestScanRun();
  const due = scanDue(
    now,
    scan ? { startedAtMs: scan.started_at_ms, failed: scan.decision === 'DATA_UNAVAILABLE' } : null,
    SCAN_OFFSET_MS,
  );

  if (due) {
    try {
      const r = await runRefresh({ waitMs: 30_000 });
      log(
        'scan',
        `${r.decision ?? '—'} · ${r.setups} setup · sim ${r.simUpdated} updated / ${r.simOpened} opened · ` +
          `${r.alertsCreated} alert · ${((r.finishedAtMs - r.startedAtMs) / 1000).toFixed(0)}s${r.error ? ` · ${r.error}` : ''}`,
      );
      ai.run(aiJob);
    } catch (err) {
      if (err instanceof JobBusyError) log('scan', 'another scan is running; retrying next minute');
      else throw err;
    }
  } else {
    try {
      const m = await runMonitor();
      const changed = m.setupsChanged + m.simChanged + m.simOpened + m.alertsCreated > 0;
      // Quiet unless something happened, with a sign of life every 15 minutes.
      if (changed || now - last.monitorLogMs >= 15 * MINUTE) {
        last.monitorLogMs = now;
        log(
          'monitor',
          `${m.decision ?? '—'} · setups changed ${m.setupsChanged} · sim ${m.simChanged} updated / ${m.simOpened} opened · ${m.alertsCreated} alert`,
        );
      }
    } catch (err) {
      if (!(err instanceof JobBusyError)) throw err; // a scan from the app is running; it does the same work
    }
  }

  const newest = Math.max(0, ...[...(await latestValidations()).values()].map((v) => v.computed_at_ms));
  if (!shuttingDown && intervalDue(Date.now(), newest || null, VALIDATE_MS)) {
    log('validate', 'starting (backfills only new candles; the monitor pauses meanwhile)');
    const jobId = await startJob('validate');
    try {
      const rows = await runValidation();
      await finishJob(jobId, 'ok', rows.map((r) => ({ strategy: r.strategy_id, timeframe: r.timeframe, label: r.label })));
      log('validate', rows.map((r) => `${r.strategy_id} ${r.timeframe}: ${r.label}`).join(' · '));
    } catch (err) {
      await finishJob(jobId, 'error', {}, errText(err));
      throw err;
    }
  }
}

async function aiJob(): Promise<void> {
  const r = await explainTopSetups({ max: AI_SETUPS, shouldStop: () => shuttingDown });
  if (r.skipped) return;
  const parts = [
    r.explained.length ? `explained ${r.explained.join(', ')}` : '',
    r.reused.length ? `reused for ${r.reused.join(', ')}` : '',
    r.failed.length ? `failed ${r.failed.join(' | ')}` : '',
  ].filter(Boolean);
  if (parts.length) log('ai', parts.join(' · '));
}

async function backgroundJob(): Promise<void> {
  const now = Date.now();
  if (intervalDue(now, last.news, NEWS_MS)) {
    last.news = now;
    const r = await ingestNews(25);
    log('news', JSON.stringify(r).slice(0, 200));
  }
  if (intervalDue(now, last.evaluate, EVALUATE_MS)) {
    last.evaluate = now;
    const r = await evaluateStoredSignals();
    log('evaluate', JSON.stringify(r));
  }
}

function tick() {
  market.run(marketJob);
  background.run(backgroundJob);
}

async function main() {
  await db(); // applies pending migrations before anything else runs
  console.log('AI Trade worker started.');
  console.log(`  scan     : hourly, ${SCAN_OFFSET_MS / 1000}s after each candle close`);
  console.log('  monitor  : every minute between scans (prices, setups, simulations, your positions, alerts)');
  console.log(`  ai       : top ${AI_SETUPS} setups after each scan (free tier, calls spaced 70s)`);
  console.log(`  validate : every ${VALIDATE_MS / 3_600_000}h · news every ${NEWS_MS / MINUTE} min · evaluation every ${EVALUATE_MS / MINUTE} min`);
  console.log('Press Ctrl+C to stop.\n');

  tick();
  ai.run(aiJob); // setups from a scan made before the worker started
  const timer = setInterval(tick, MINUTE);

  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    // Hand back a lock held mid-job, so the app's "Refresh now" is not blocked until it expires.
    await releaseHeldLocks().catch(() => {});
    console.log('\nWorker stopped.');
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => {
  console.error('Worker crashed:', err);
  process.exit(1);
});
