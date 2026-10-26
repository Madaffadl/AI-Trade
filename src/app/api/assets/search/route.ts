import { NextResponse } from 'next/server';
import { z } from 'zod';
import { cryptoProvider, stockProviders } from '@/lib/providers/registry';
import { ProviderError } from '@/lib/providers/http';
import { searchCatalog } from '@/lib/markets/catalog';
import type { SymbolInfo } from '@/lib/providers/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Query = z.object({
  q: z.string().min(1).max(40).regex(/^[A-Za-z0-9 ._:-]+$/, 'Unsupported characters in query'),
  assetClass: z.enum(['crypto', 'stock', 'any']).default('any'),
});

/**
 * Symbol search.
 *
 * Catalogue first, providers second. The catalogue is a local table of every
 * instrument the configured providers offer (crypto + US + IDX), so it answers
 * without network access or quota. Live providers are then asked only as a
 * top-up, and each one's failure is reported individually — including
 * "not configured", which the previous version swallowed into an empty list.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = Query.safeParse({
    q: url.searchParams.get('q') ?? '',
    assetClass: url.searchParams.get('assetClass') ?? 'any',
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 });
  }
  const { q, assetClass } = parsed.data;
  const classFilter = assetClass === 'any' ? undefined : assetClass;

  // ---- 1. Local catalogue ------------------------------------------------
  const catalogRows = await searchCatalog(q, { assetClass: classFilter, limit: 40 });
  const results: SymbolInfo[] = catalogRows.map((r) => ({
    symbol: r.symbol,
    displayName: r.display_name,
    exchangeId: r.exchange_id,
    assetClass: r.asset_class as 'crypto' | 'stock',
    currency: r.currency,
    tickSize: r.tick_size,
    lotSize: r.lot_size,
    minNotional: r.min_notional,
  }));

  const seen = new Set(results.map((r) => `${r.exchangeId}:${r.symbol}`));

  // ---- 2. Live providers, as a top-up ------------------------------------
  const errors: { provider: string; error: string }[] = [];
  const notices: { provider: string; notice: string }[] = [];

  const providers =
    classFilter === 'crypto'
      ? [cryptoProvider()]
      : classFilter === 'stock'
        ? stockProviders()
        : [cryptoProvider(), ...stockProviders()];

  for (const p of providers) {
    if (!p.searchSymbols) {
      notices.push({ provider: p.id, notice: 'This provider does not offer symbol search.' });
      continue;
    }
    if (!p.isConfigured()) {
      // Previously this was a silent `continue`, so a missing API key looked
      // exactly like "no such symbol".
      notices.push({ provider: p.id, notice: 'Not configured (no API key), so it was not queried.' });
      continue;
    }
    try {
      for (const hit of await p.searchSymbols(q)) {
        const key = `${hit.exchangeId}:${hit.symbol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(hit);
      }
    } catch (err) {
      errors.push({ provider: p.id, error: err instanceof ProviderError ? err.message : String(err) });
    }
  }

  return NextResponse.json({
    results: results.slice(0, 40),
    errors,
    notices,
    source: { catalog: catalogRows.length, providers: results.length - catalogRows.length },
  });
}
