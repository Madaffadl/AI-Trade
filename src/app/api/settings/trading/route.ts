import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getTradingSettings, updateTradingSettings } from '@/lib/settings/trading';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await getTradingSettings());
}

/** Partial update; unknown fields and out-of-range values are rejected, not clamped. */
export async function POST(request: Request) {
  try {
    const saved = await updateTradingSettings(await request.json().catch(() => null));
    return NextResponse.json(saved);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') },
        { status: 400 },
      );
    }
    throw err;
  }
}
