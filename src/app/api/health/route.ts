import { NextResponse } from 'next/server';
import { db } from '@/lib/db/driver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness probe. Deliberately exposes no configuration, provider names, or
 * counts - it is the only unauthenticated route besides login.
 */
export async function GET() {
  try {
    const d = await db();
    await d.get('SELECT 1 AS ok');
    return NextResponse.json({ status: 'ok' });
  } catch {
    return NextResponse.json({ status: 'degraded' }, { status: 503 });
  }
}
