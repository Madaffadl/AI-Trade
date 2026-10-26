import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAssetById } from '@/lib/db/repo';
import { analyzeAsset } from '@/lib/analysis/service';
import { TIMEFRAMES } from '@/lib/market/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const Body = z.object({
  assetId: z.string().uuid(),
  timeframe: z.enum(TIMEFRAMES),
  /** Explicit opt-in: a page render never triggers a paid AI call. */
  allowAiCall: z.boolean().default(false),
  force: z.boolean().default(false),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 });
  }

  const asset = await getAssetById(parsed.data.assetId);
  if (!asset) return NextResponse.json({ error: 'Unknown asset' }, { status: 404 });

  const result = await analyzeAsset(asset, parsed.data.timeframe, {
    allowAiCall: parsed.data.allowAiCall,
    force: parsed.data.force,
  });
  return NextResponse.json(result);
}
