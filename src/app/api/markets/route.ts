import { NextResponse } from 'next/server';
import { z } from 'zod';
import { syncCatalog } from '@/lib/markets/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const Body = z.object({ action: z.literal('sync') });

/**
 * Refresh the instrument catalogue. Deliberately a POST the user triggers:
 * it pulls several megabytes of reference data and must never run on a page
 * render.
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  return NextResponse.json({ results: await syncCatalog() });
}
