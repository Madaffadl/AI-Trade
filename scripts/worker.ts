import './_bootstrap';
import { runRefresh } from '../src/lib/jobs/refresh';
import { ingestNews } from '../src/lib/news/ingest';
import { evaluateStoredSignals } from '../src/lib/evaluation/forward';

/**
 * Local scheduler.
 *
 * A plain long-running Node process - no cron daemon, no queue, no Redis. This
 * is the recommended way to get genuinely continuous monitoring, because most
 * free serverless tiers cannot run background work reliably (see
 * docs/DEPLOYMENT.md). On a serverless host, call the /api/cron/* endpoints
 * from an external scheduler instead.
 *
 * Intervals are conservative to stay inside free provider quotas.
 */

const MINUTE = 60_000;

interface Task {
  name: string;
  intervalMs: number;
  lastRunMs: number;
  run: () => Promise<unknown>;
}

const tasks: Task[] = [
  {
    name: 'refresh',
    intervalMs: Number(process.env.WORKER_REFRESH_MINUTES ?? 15) * MINUTE,
    lastRunMs: 0,
    run: () => runRefresh(),
  },
  {
    name: 'news',
    intervalMs: Number(process.env.WORKER_NEWS_MINUTES ?? 30) * MINUTE,
    lastRunMs: 0,
    run: () => ingestNews(25),
  },
  {
    name: 'evaluate',
    intervalMs: Number(process.env.WORKER_EVALUATE_MINUTES ?? 60) * MINUTE,
    lastRunMs: 0,
    run: () => evaluateStoredSignals(),
  },
];

let shuttingDown = false;

async function tick() {
  const now = Date.now();
  for (const task of tasks) {
    if (shuttingDown) return;
    if (now - task.lastRunMs < task.intervalMs) continue;
    task.lastRunMs = now;
    const startedAt = Date.now();
    try {
      const result = await task.run();
      console.log(
        `[${new Date().toISOString()}] ${task.name} ok in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        JSON.stringify(result).slice(0, 300),
      );
    } catch (err) {
      // A failing task must never kill the worker.
      console.error(`[${new Date().toISOString()}] ${task.name} FAILED:`, err instanceof Error ? err.message : err);
    }
  }
}

async function main() {
  console.log('AI Trade worker started.');
  for (const t of tasks) console.log(`  ${t.name}: every ${t.intervalMs / MINUTE} min`);
  console.log('Press Ctrl+C to stop.\n');

  await tick();
  const timer = setInterval(() => void tick(), MINUTE);

  const stop = () => {
    shuttingDown = true;
    clearInterval(timer);
    console.log('\nWorker stopped.');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('Worker crashed:', err);
  process.exit(1);
});
