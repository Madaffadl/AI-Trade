import { NextResponse } from 'next/server';
import { z } from 'zod';
import { IndodaxProvider } from '@/lib/providers/crypto/indodax';
import { getSimTrade } from '@/lib/sim/repo';
import { closeSimulation } from '@/lib/sim/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  action: z.enum(['close', 'cancel']),
  /** Share of the open quantity to sell; 1 closes the position. */
  fraction: z.number().gt(0).max(1).default(1),
});

/** Close (fully or partly) an open simulation at the live bid, or cancel a pending one. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 });

  const trade = await getSimTrade(id);
  if (!trade) return NextResponse.json({ error: 'Unknown simulation' }, { status: 404 });
  if (parsed.data.action === 'cancel' && trade.status !== 'pending_entry') {
    return NextResponse.json({ error: 'Only a pending simulation can be cancelled' }, { status: 409 });
  }
  if (parsed.data.action === 'close' && trade.status !== 'open') {
    return NextResponse.json({ error: 'Only an open simulation can be closed' }, { status: 409 });
  }

  let quote = null;
  if (parsed.data.action === 'close') {
    try {
      const t = await new IndodaxProvider().fetchTicker(trade.symbol);
      quote = { bid: t.buy, ask: t.sell, atMs: t.serverTimeMs || Date.now() };
    } catch (err) {
      return NextResponse.json({ error: `Indodax price unavailable: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
    }
  }
  const state = await closeSimulation(trade, quote, parsed.data.fraction);
  return NextResponse.json({ status: state.status, realizedPnlIdr: state.realizedPnlIdr });
}
