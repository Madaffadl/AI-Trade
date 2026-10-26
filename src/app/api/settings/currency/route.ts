import { NextResponse } from 'next/server';
import { z } from 'zod';
import { SUPPORTED_DISPLAY, setDisplayCurrencySetting } from '@/lib/fx/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ currency: z.enum(SUPPORTED_DISPLAY) });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'currency must be native, USD or IDR' }, { status: 400 });
  }
  await setDisplayCurrencySetting(parsed.data.currency);
  return NextResponse.json({ ok: true });
}
