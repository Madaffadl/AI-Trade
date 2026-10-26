import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listAlerts, markAlertRead, markAllAlertsRead } from '@/lib/notifications/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchBody = z.object({ id: z.string().uuid().optional(), all: z.boolean().optional() });

export async function GET(request: Request) {
  const unreadOnly = new URL(request.url).searchParams.get('unread') === '1';
  return NextResponse.json({ alerts: await listAlerts(100, unreadOnly) });
}

export async function PATCH(request: Request) {
  const parsed = PatchBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  if (parsed.data.all) {
    return NextResponse.json({ ok: true, marked: await markAllAlertsRead() });
  }
  if (parsed.data.id) {
    await markAlertRead(parsed.data.id);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: 'Provide "id" or "all"' }, { status: 400 });
}
