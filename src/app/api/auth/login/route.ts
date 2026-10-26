import { NextResponse } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/config/env';
import { createSessionToken, SESSION_COOKIE, timingSafeEqual } from '@/lib/auth/session';

export const runtime = 'nodejs';

const Body = z.object({ password: z.string().min(1).max(512) });

/** In-memory throttle. Resets on restart; adequate for a single-user app. */
const attempts = new Map<string, { count: number; firstAtMs: number }>();
const WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 8;

function throttled(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.firstAtMs > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAtMs: now });
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

export async function POST(request: Request) {
  const e = env();
  if (e.AUTH_PASSWORD === '' || e.AUTH_SESSION_SECRET === '') {
    return NextResponse.json(
      { error: 'Password authentication is not configured on this instance.' },
      { status: 400 },
    );
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  if (throttled(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (!timingSafeEqual(parsed.data.password, e.AUTH_PASSWORD)) {
    // Deliberately vague: no hint about whether the password was close.
    return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 });
  }

  attempts.delete(ip);
  const token = await createSessionToken(e.AUTH_SESSION_SECRET, e.AUTH_SESSION_HOURS);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: e.AUTH_SESSION_HOURS * 3600,
  });
  return response;
}
