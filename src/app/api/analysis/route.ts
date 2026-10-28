import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAssetById } from '@/lib/db/repo';
import { analyzeAsset } from '@/lib/analysis/service';
import { outOfSampleFor } from '@/lib/evaluation/validate';
import { TIMEFRAMES } from '@/lib/market/types';
import { getSetup } from '@/lib/plan/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The AI fallback chain may wait on more than one provider in turn.
export const maxDuration = 300;

const Body = z.object({
  assetId: z.string().uuid(),
  timeframe: z.enum(TIMEFRAMES),
  /** Explain this setup's trade plan (its numbers and validation label go into the prompt). */
  setupId: z.string().uuid().optional(),
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

  const setup = parsed.data.setupId ? await getSetup(parsed.data.setupId) : null;
  if (parsed.data.setupId && (!setup || setup.asset_id !== asset.id)) {
    return NextResponse.json({ error: 'Unknown setup' }, { status: 404 });
  }

  const result = await analyzeAsset(asset, setup ? (setup.timeframe as typeof parsed.data.timeframe) : parsed.data.timeframe, {
    allowAiCall: parsed.data.allowAiCall,
    force: parsed.data.force,
    setup: setup ? { setup, outOfSample: await outOfSampleFor(setup.strategy_id, setup.timeframe) } : undefined,
  });
  return NextResponse.json(result);
}
