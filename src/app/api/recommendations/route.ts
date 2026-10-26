import { NextResponse } from 'next/server';
import { z } from 'zod';
import { recommendCandidates } from '@/lib/markets/recommend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Query = z.object({
  exchange: z.enum(['BINANCE', 'INDODAX', 'all']).default('all'),
  band: z.enum(['liquid', 'active', 'speculative', 'thin', 'any']).default('any'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  minRangePct: z.coerce.number().min(0).max(100).default(0.5),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = Query.safeParse({
    exchange: url.searchParams.get('exchange') ?? 'all',
    band: url.searchParams.get('band') ?? 'any',
    limit: url.searchParams.get('limit') ?? 25,
    minRangePct: url.searchParams.get('minRangePct') ?? 0.5,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 });
  }
  return NextResponse.json(await recommendCandidates(parsed.data));
}
