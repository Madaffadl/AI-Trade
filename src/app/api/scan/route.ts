import { NextResponse } from 'next/server';
import { JobBusyError } from '@/lib/jobs/lock';
import { runRefresh } from '@/lib/jobs/refresh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A full scan fetches ~3 candle series for each of up to 25 pairs, paced
// inside Indodax's rate limit: typically 20-40 seconds.
export const maxDuration = 120;

/**
 * Run one full refresh cycle now (scan, live check, simulations, holdings).
 * Protected by the app's auth like every other API route. Waits briefly for
 * the worker's one-minute live check to finish; a scan already in progress
 * answers 409.
 */
export async function POST() {
  try {
    const r = await runRefresh({ waitMs: 15_000 });
    return NextResponse.json(
      { scanId: r.scanId, decision: r.decision, simUpdated: r.simUpdated, simOpened: r.simOpened, error: r.error },
      { status: r.decision === 'DATA_UNAVAILABLE' ? 502 : 200 },
    );
  } catch (err) {
    if (err instanceof JobBusyError) return NextResponse.json({ error: 'A scan is already running.' }, { status: 409 });
    throw err;
  }
}
