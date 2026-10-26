import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAssetById } from '@/lib/db/repo';
import { TIMEFRAMES, SIGNAL_ACTIONS } from '@/lib/market/types';
import { runEngineForAsset } from '@/lib/signals/engine';
import { listSignals } from '@/lib/signals/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RunBody = z.object({
  assetId: z.string().uuid(),
  timeframe: z.enum(TIMEFRAMES),
  force: z.boolean().default(false),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const status = url.searchParams.get('status');
  const parsedAction = action && (SIGNAL_ACTIONS as readonly string[]).includes(action) ? action : undefined;

  return NextResponse.json({
    signals: await listSignals({
      action: parsedAction as (typeof SIGNAL_ACTIONS)[number] | undefined,
      status: status ?? undefined,
      limit: 100,
    }),
  });
}

/** Re-run the deterministic engine for one asset/timeframe on demand. */
export async function POST(request: Request) {
  const parsed = RunBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 });
  }
  const asset = await getAssetById(parsed.data.assetId);
  if (!asset) return NextResponse.json({ error: 'Unknown asset' }, { status: 404 });

  const result = await runEngineForAsset(asset, parsed.data.timeframe, { force: parsed.data.force });
  return NextResponse.json(result);
}
