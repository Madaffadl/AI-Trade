import { notFound, redirect } from 'next/navigation';
import { db } from '@/lib/db/driver';
import { getAssetBySymbol, upsertAsset } from '@/lib/db/repo';
import type { AssetClass } from '@/lib/market/types';
import type { CatalogRow } from '@/lib/markets/catalog';

export const dynamic = 'force-dynamic';

/**
 * Open any catalogued instrument, whether or not it is on the watchlist.
 *
 * This works because `assets` ("instruments we know about") is deliberately
 * separate from `watchlist_assets` ("instruments we actively refresh"). Opening
 * a product registers the asset so the detail page can chart it, but does NOT
 * add it to the watchlist — browsing must never silently commit you to
 * spending provider quota on something.
 */
export default async function OpenCatalogItem({
  params,
}: {
  params: Promise<{ exchangeId: string; symbol: string }>;
}) {
  const { exchangeId, symbol } = await params;
  const decodedSymbol = decodeURIComponent(symbol).toUpperCase();
  const decodedExchange = decodeURIComponent(exchangeId).toUpperCase();

  // Already registered? Go straight there.
  const existing = await getAssetBySymbol(decodedSymbol, decodedExchange);
  if (existing) redirect(`/assets/${existing.id}`);

  const d = await db();
  const row = await d.get<CatalogRow>(
    'SELECT * FROM instrument_catalog WHERE exchange_id = ? AND symbol = ?',
    [decodedExchange, decodedSymbol],
  );
  if (!row) notFound();

  const asset = await upsertAsset({
    symbol: row.symbol,
    displayName: row.display_name,
    assetClass: row.asset_class as AssetClass,
    exchangeId: row.exchange_id,
    currency: row.currency,
    // Real exchange increments when the catalogue has them; null stays null so
    // position sizing discloses the gap instead of inventing a lot size.
    tickSize: row.tick_size,
    lotSize: row.lot_size,
    minNotional: row.min_notional,
  });

  redirect(`/assets/${asset.id}`);
}
