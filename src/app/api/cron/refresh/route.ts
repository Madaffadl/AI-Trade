import { NextResponse } from 'next/server';
import { authorizeCron } from '@/lib/auth/cron';
import { runRefresh } from '@/lib/jobs/refresh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Scheduled refreshes can take a while on a cold cache.
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = authorizeCron(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const summary = await runRefresh({ force: new URL(request.url).searchParams.get('force') === '1' });
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Refresh failed' }, { status: 500 });
  }
}
