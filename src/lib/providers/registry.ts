import 'server-only';
import type { AssetClass, Timeframe } from '@/lib/market/types';
import { IndodaxProvider } from './crypto/indodax';
import type { MarketDataProvider } from './types';

/**
 * Provider selection - Indodax only.
 *
 * The app is scoped to Indodax spot IDR pairs (2026-10-29). Every asset is
 * priced by the venue it trades on, so an asset on any other exchange is
 * reported as unsupported rather than priced from a different market.
 */

export function allProviders(): MarketDataProvider[] {
  return [new IndodaxProvider()];
}

export type ProviderSelection =
  | { ok: true; provider: MarketDataProvider }
  | { ok: false; reason: string; candidates: { id: string; why: string }[]; remedy: string | null };

export function selectProvider(assetClass: AssetClass, exchangeId: string, timeframe: Timeframe): ProviderSelection {
  const indodax = new IndodaxProvider();
  if (assetClass !== 'crypto' || exchangeId !== 'INDODAX') {
    return {
      ok: false,
      reason: `Only Indodax crypto pairs are supported; ${exchangeId} is not.`,
      candidates: [{ id: indodax.id, why: `does not cover ${exchangeId}` }],
      remedy: null,
    };
  }
  if (!indodax.supportsTimeframe(timeframe)) {
    return {
      ok: false,
      reason: `Indodax does not provide ${timeframe} bars.`,
      candidates: [{ id: indodax.id, why: `does not provide ${timeframe} bars` }],
      remedy: null,
    };
  }
  return { ok: true, provider: indodax };
}

/** Coverage matrix for the Settings page. */
export function coverageMatrix() {
  return allProviders().map((p) => ({
    id: p.id,
    label: p.label,
    assetClass: p.assetClass,
    requiresKey: p.requiresKey,
    configured: p.isConfigured(),
    capabilities: p.capabilities,
  }));
}
