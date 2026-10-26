import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAssetById } from '@/lib/db/repo';
import { TIMEFRAMES, TRADING_STYLES } from '@/lib/market/types';
import { closePosition, createPosition, deletePosition, listPositions, updatePositionPlan } from '@/lib/positions/repo';
import { VENUES } from '@/lib/positions/types';
import { getSignal } from '@/lib/signals/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A price must be a real positive number; IDR values are large, so no upper bound beyond sanity. */
const price = z.number().finite().positive().max(1e15);

const CreateBody = z.object({
  assetId: z.string().uuid(),
  venue: z.enum(VENUES),
  quantity: z.number().finite().positive().max(1e12),
  entryPrice: price,
  entryAtMs: z.number().int().positive().optional(),
  entryFee: z.number().finite().min(0).max(1e12).nullable().default(null),
  stopLoss: price.nullable().default(null),
  takeProfit1: price.nullable().default(null),
  takeProfit2: price.nullable().default(null),
  timeframe: z.enum(TIMEFRAMES),
  tradingStyle: z.enum(TRADING_STYLES),
  openedFromSignalId: z.string().uuid().nullable().default(null),
  notes: z.string().max(1000).nullable().default(null),
});

const CloseBody = z.object({
  id: z.string().uuid(),
  exitPrice: price,
  exitAtMs: z.number().int().positive().optional(),
  exitFee: z.number().finite().min(0).max(1e12).nullable().default(null),
  exitReason: z.string().max(300).nullable().default(null),
});

const PlanBody = z.object({
  id: z.string().uuid(),
  stopLoss: price.nullable().default(null),
  takeProfit1: price.nullable().default(null),
  takeProfit2: price.nullable().default(null),
  notes: z.string().max(1000).nullable().default(null),
});

export async function GET(request: Request) {
  const status = new URL(request.url).searchParams.get('status');
  const filter = status === 'open' || status === 'closed' ? status : undefined;
  return NextResponse.json({ positions: await listPositions(filter) });
}

/** Record a purchase that already happened at a real venue. */
export async function POST(request: Request) {
  const parsed = CreateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, { status: 400 });
  }
  const body = parsed.data;

  const asset = await getAssetById(body.assetId);
  if (!asset) return NextResponse.json({ error: 'Unknown asset' }, { status: 404 });

  // Plan geometry must be coherent, or the resulting risk figures are nonsense.
  if (body.stopLoss !== null && body.stopLoss >= body.entryPrice) {
    return NextResponse.json({ error: 'Stop-loss must be below your entry price for a long position.' }, { status: 400 });
  }
  if (body.takeProfit1 !== null && body.takeProfit1 <= body.entryPrice) {
    return NextResponse.json({ error: 'Take-profit 1 must be above your entry price.' }, { status: 400 });
  }
  if (body.takeProfit2 !== null && body.takeProfit1 !== null && body.takeProfit2 <= body.takeProfit1) {
    return NextResponse.json({ error: 'Take-profit 2 must be above take-profit 1.' }, { status: 400 });
  }

  let strategyId: string | null = null;
  let strategyVersion: string | null = null;
  if (body.openedFromSignalId) {
    const signal = await getSignal(body.openedFromSignalId);
    if (!signal) return NextResponse.json({ error: 'Unknown signal' }, { status: 404 });
    strategyId = signal.strategy_id;
    strategyVersion = signal.strategy_version;
  }

  const position = await createPosition({
    assetId: body.assetId,
    venue: body.venue,
    quantity: body.quantity,
    entryPrice: body.entryPrice,
    entryAtMs: body.entryAtMs ?? Date.now(),
    entryFee: body.entryFee,
    stopLoss: body.stopLoss,
    takeProfit1: body.takeProfit1,
    takeProfit2: body.takeProfit2,
    timeframe: body.timeframe,
    tradingStyle: body.tradingStyle,
    strategyId,
    strategyVersion,
    openedFromSignalId: body.openedFromSignalId,
    notes: body.notes,
  });

  return NextResponse.json({ ok: true, position });
}

/** Record the sale that already happened, and realise the P&L. */
export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null);

  const asClose = CloseBody.safeParse(body);
  if (asClose.success) {
    const closed = await closePosition(
      asClose.data.id,
      asClose.data.exitPrice,
      asClose.data.exitAtMs ?? Date.now(),
      asClose.data.exitFee,
      asClose.data.exitReason,
    );
    if (!closed) return NextResponse.json({ error: 'Position not found or already closed' }, { status: 404 });
    return NextResponse.json({ ok: true, position: closed });
  }

  const asPlan = PlanBody.safeParse(body);
  if (asPlan.success) {
    await updatePositionPlan(asPlan.data.id, {
      stopLoss: asPlan.data.stopLoss,
      takeProfit1: asPlan.data.takeProfit1,
      takeProfit2: asPlan.data.takeProfit2,
      notes: asPlan.data.notes,
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Body must be either a close request or a plan update.' }, { status: 400 });
}

export async function DELETE(request: Request) {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'id must be a uuid' }, { status: 400 });
  await deletePosition(parsed.data.id);
  return NextResponse.json({ ok: true });
}
