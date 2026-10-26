import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db/driver';
import { getAssetById, newId, nowMs } from '@/lib/db/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  assetId: z.string().uuid(),
  direction: z.enum(['above', 'below']),
  price: z.number().finite().positive(),
});

export async function GET() {
  const d = await db();
  const rows = await d.all(
    `SELECT t.*, a.symbol, a.currency FROM price_thresholds t JOIN assets a ON a.id = t.asset_id
     ORDER BY t.created_at_ms DESC LIMIT 100`,
  );
  return NextResponse.json({ thresholds: rows });
}

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 });
  }
  const asset = await getAssetById(parsed.data.assetId);
  if (!asset) return NextResponse.json({ error: 'Unknown asset' }, { status: 404 });

  const d = await db();
  await d.run(
    `INSERT INTO price_thresholds (id, asset_id, direction, price, active, created_at_ms)
     VALUES (?,?,?,?,1,?)
     ON CONFLICT (asset_id, direction, price) DO UPDATE SET active = 1, triggered_at_ms = NULL`,
    [newId(), parsed.data.assetId, parsed.data.direction, parsed.data.price, nowMs()],
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'id must be a uuid' }, { status: 400 });
  const d = await db();
  await d.run('DELETE FROM price_thresholds WHERE id = ?', [parsed.data.id]);
  return NextResponse.json({ ok: true });
}
