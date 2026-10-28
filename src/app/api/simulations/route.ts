import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSetup } from '@/lib/plan/repo';
import { IndodaxProvider } from '@/lib/providers/crypto/indodax';
import { startSimulation } from '@/lib/sim/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ setupId: z.string().min(1) });

/** Start a manual simulation of a setup, priced against Indodax's live order book. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'setupId is required' }, { status: 400 });

  const setup = await getSetup(parsed.data.setupId);
  if (!setup) return NextResponse.json({ error: 'Unknown setup' }, { status: 404 });

  // A user action may call the exchange once; a page render never does.
  let quote = null;
  try {
    const t = await new IndodaxProvider().fetchTicker(setup.plan.symbol);
    quote = { bid: t.buy, ask: t.sell, atMs: t.serverTimeMs || Date.now() };
  } catch {
    quote = null; // the order rests and the next refresh fills it
  }

  const r = await startSimulation(setup, 'manual', quote);
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 409 });
  return NextResponse.json({ id: r.trade.id, filled: r.filled, status: r.trade.status });
}
