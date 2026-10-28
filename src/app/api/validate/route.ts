import { NextResponse } from 'next/server';
import { db } from '@/lib/db/driver';
import { finishJob, nowMs, startJob } from '@/lib/db/repo';
import { runValidation } from '@/lib/evaluation/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The first run backfills months of candles for every pair: 1-2 minutes.
export const maxDuration = 300;

/** Backfill Indodax history and validate every strategy x timeframe. */
export async function POST() {
  const d = await db();
  const running = await d.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM job_runs WHERE job = 'validate' AND status = 'running' AND started_at_ms > ?`,
    [nowMs() - 10 * 60_000],
  );
  if (Number(running?.n ?? 0) > 0) return NextResponse.json({ error: 'A validation is already running.' }, { status: 409 });

  const jobId = await startJob('validate');
  try {
    const rows = await runValidation();
    const summary = rows.map((r) => ({ strategy: r.strategy_id, timeframe: r.timeframe, label: r.label }));
    await finishJob(jobId, 'ok', summary);
    return NextResponse.json({ results: summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishJob(jobId, 'error', {}, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
