import { NextResponse } from 'next/server';
import { authorizeCron } from '@/lib/auth/cron';
import { evaluateStoredSignals } from '@/lib/evaluation/forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = authorizeCron(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    return NextResponse.json(await evaluateStoredSignals());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Evaluation failed' }, { status: 500 });
  }
}
