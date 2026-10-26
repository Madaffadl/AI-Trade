import { NextResponse } from 'next/server';
import { z } from 'zod';
import { setLocale } from '@/lib/i18n';
import { LOCALES } from '@/lib/i18n/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ locale: z.enum(LOCALES) });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'locale must be en or id' }, { status: 400 });
  }
  await setLocale(parsed.data.locale);
  return NextResponse.json({ ok: true });
}
