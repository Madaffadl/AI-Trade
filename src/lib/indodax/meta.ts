import 'server-only';
import { getSetting, setSetting } from '@/lib/db/repo';
import { ProviderError } from '@/lib/providers/http';
import { fetchPairs, type IndodaxPairMeta } from './api';

/**
 * Per-pair trading rules (fees, increments, minimum order, maintenance flag),
 * cached for a day: they change rarely and the list is ~450 rows.
 *
 * If a refresh fails, the previous copy is used and flagged as stale rather
 * than inventing defaults. With no copy at all the error propagates - a fee
 * or minimum order is never guessed.
 */

const KEY = 'indodax.pairs';
const MAX_AGE_MS = 24 * 3_600_000;

interface Stored {
  fetchedAtMs: number;
  pairs: IndodaxPairMeta[];
}

export interface PairsMeta {
  bySymbol: Map<string, IndodaxPairMeta>;
  fetchedAtMs: number;
  stale: boolean;
  error: string | null;
}

export async function getPairsMeta(options: { force?: boolean } = {}): Promise<PairsMeta> {
  const cached = await getSetting<Stored | null>(KEY, null);
  const fresh = cached && Date.now() - cached.fetchedAtMs < MAX_AGE_MS;
  if (cached && fresh && !options.force) {
    return { bySymbol: index(cached.pairs), fetchedAtMs: cached.fetchedAtMs, stale: false, error: null };
  }
  try {
    const pairs = await fetchPairs();
    const stored: Stored = { fetchedAtMs: Date.now(), pairs };
    await setSetting(KEY, stored);
    return { bySymbol: index(pairs), fetchedAtMs: stored.fetchedAtMs, stale: false, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!cached) throw err instanceof ProviderError ? err : new ProviderError(message, 'network');
    return { bySymbol: index(cached.pairs), fetchedAtMs: cached.fetchedAtMs, stale: true, error: message };
  }
}

function index(pairs: readonly IndodaxPairMeta[]): Map<string, IndodaxPairMeta> {
  return new Map(pairs.map((p) => [p.symbol, p]));
}
