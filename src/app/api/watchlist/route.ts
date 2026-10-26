import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  addToWatchlist,
  ensureDefaultWatchlist,
  getAssetBySymbol,
  listWatchlist,
  removeFromWatchlist,
  upsertAsset,
} from '@/lib/db/repo';
import { TRADING_STYLES } from '@/lib/market/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AddBody = z.object({
  symbol: z.string().min(1).max(32).regex(/^[A-Za-z0-9._:-]+$/, 'Symbol contains unsupported characters'),
  displayName: z.string().min(1).max(120),
  assetClass: z.enum(['crypto', 'stock']),
  exchangeId: z.enum(['BINANCE', 'COINBASE', 'INDODAX', 'US', 'IDX']),
  currency: z.string().min(1).max(10),
  tradingStyle: z.enum(TRADING_STYLES),
});

const RemoveBody = z.object({ assetId: z.string().uuid() });

export async function GET() {
  const watchlistId = await ensureDefaultWatchlist();
  return NextResponse.json({ items: await listWatchlist(watchlistId) });
}

export async function POST(request: Request) {
  const parsed = AddBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 });
  }
  const body = parsed.data;
  const watchlistId = await ensureDefaultWatchlist();

  const existing = await getAssetBySymbol(body.symbol, body.exchangeId);
  const asset =
    existing ??
    (await upsertAsset({
      symbol: body.symbol.toUpperCase(),
      displayName: body.displayName,
      assetClass: body.assetClass,
      exchangeId: body.exchangeId,
      currency: body.currency.toUpperCase(),
      tickSize: null,
      lotSize: null,
      minNotional: null,
    }));

  await addToWatchlist(watchlistId, asset.id, body.tradingStyle);
  return NextResponse.json({ ok: true, asset });
}

export async function DELETE(request: Request) {
  const parsed = RemoveBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'assetId must be a uuid' }, { status: 400 });
  const watchlistId = await ensureDefaultWatchlist();
  await removeFromWatchlist(watchlistId, parsed.data.assetId);
  return NextResponse.json({ ok: true });
}
