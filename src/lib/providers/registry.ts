import 'server-only';
import { env } from '@/lib/config/env';
import type { AssetClass, Timeframe } from '@/lib/market/types';
import { BinanceProvider } from './crypto/binance';
import { CoinbaseProvider } from './crypto/coinbase';
import { IndodaxProvider } from './crypto/indodax';
import { AlphaVantageProvider } from './stocks/alphavantage';
import { NasdaqProvider } from './stocks/nasdaq';
import { TwelveDataProvider } from './stocks/twelvedata';
import { YahooProvider } from './stocks/yahoo';
import type { MarketDataProvider } from './types';

/**
 * Provider selection.
 *
 * Crypto uses a single configured provider. Stocks use an ordered preference
 * list, because no single free provider covers both US and IDX markets at all
 * timeframes - the registry picks the first configured provider that genuinely
 * supports the requested exchange AND timeframe, and reports honestly when
 * nothing does.
 */

const CRYPTO: Record<string, () => MarketDataProvider> = {
  binance: () => new BinanceProvider(),
  coinbase: () => new CoinbaseProvider(),
  indodax: () => new IndodaxProvider(),
};

const STOCK: Record<string, () => MarketDataProvider> = {
  nasdaq: () => new NasdaqProvider(),
  alphavantage: () => new AlphaVantageProvider(),
  twelvedata: () => new TwelveDataProvider(),
  yahoo: () => new YahooProvider(),
};

export function cryptoProvider(): MarketDataProvider {
  const factory = CRYPTO[env().CRYPTO_PROVIDER] ?? CRYPTO.binance!;
  return factory();
}

export function stockProviders(): MarketDataProvider[] {
  return env()
    .STOCK_PROVIDERS.map((id) => STOCK[id])
    .filter((f): f is () => MarketDataProvider => Boolean(f))
    .map((f) => f());
}

export function allProviders(): MarketDataProvider[] {
  return [
    ...Object.values(CRYPTO).map((f) => f()),
    ...Object.values(STOCK).map((f) => f()),
  ];
}

/** Which exchanges an adapter can actually serve. */
function servesExchange(p: MarketDataProvider, exchangeId: string): boolean {
  if (p.assetClass === 'crypto') {
    // Each crypto venue has its own order book and quote currency, so an
    // adapter only serves its own exchange. Serving BINANCE data for an
    // INDODAX asset would show a USDT price against an IDR fill.
    if (p.id === 'indodax') return exchangeId === 'INDODAX';
    if (p.id === 'binance') return exchangeId === 'BINANCE';
    if (p.id === 'coinbase') return exchangeId === 'COINBASE';
    return false;
  }
  switch (p.id) {
    case 'nasdaq':
    case 'alphavantage':
      return exchangeId === 'US';
    case 'twelvedata':
    case 'yahoo':
      return exchangeId === 'US' || exchangeId === 'IDX';
    default:
      return false;
  }
}

export type ProviderSelection =
  | { ok: true; provider: MarketDataProvider }
  | {
      ok: false;
      reason: string;
      candidates: { id: string; why: string }[];
      /**
       * What the user can actually DO about it. A failure message that only
       * says what broke leaves the user stuck; this names the concrete next
       * step for the specific market that failed.
       */
      remedy: string | null;
    };

/**
 * Resolve the provider for an asset + timeframe, or explain precisely why no
 * provider qualifies. The explanation is shown to the user instead of silently
 * degrading to a different market or timeframe.
 */
export function selectProvider(
  assetClass: AssetClass,
  exchangeId: string,
  timeframe: Timeframe,
): ProviderSelection {
  // For crypto the asset's exchange decides the adapter: an INDODAX asset must
  // be priced by Indodax regardless of CRYPTO_PROVIDER, because the two venues
  // quote different currencies.
  const pool =
    assetClass === 'crypto'
      ? exchangeId === 'INDODAX'
        ? [new IndodaxProvider()]
        : [cryptoProvider()]
      : stockProviders();
  const candidates: { id: string; why: string }[] = [];

  for (const p of pool) {
    if (!servesExchange(p, exchangeId)) {
      candidates.push({ id: p.id, why: `does not cover ${exchangeId}` });
      continue;
    }
    if (!p.isConfigured()) {
      candidates.push({
        id: p.id,
        why: p.requiresKey ? 'API key not configured' : 'provider disabled in configuration',
      });
      continue;
    }
    if (!p.supportsTimeframe(timeframe)) {
      candidates.push({ id: p.id, why: `does not provide ${timeframe} bars` });
      continue;
    }
    return { ok: true, provider: p };
  }

  return {
    ok: false,
    reason: `No configured provider can supply ${timeframe} data for ${exchangeId}.`,
    candidates,
    remedy: remedyFor(exchangeId, assetClass),
  };
}

/** Concrete, market-specific remediation shown in the UI. */
function remedyFor(exchangeId: string, assetClass: AssetClass): string | null {
  if (exchangeId === 'IDX') {
    return (
      'Set TWELVEDATA_API_KEY (free key at twelvedata.com/apikey), then run: npm run providers:verify — ' +
      'Twelve Data already sits in the default provider order, so the key alone is enough to route IDX here. ' +
      'Their reference data lists IDX (BBCA, MIC XIDX, IDR); whether the free plan returns IDX candles is what ' +
      'providers:verify will tell you. Fallback: ENABLE_YAHOO_PROVIDER=true opts in to Yahoo\'s unofficial endpoint, ' +
      'which is rate-limited per IP — test it first with: npm run providers:verify -- --probe yahoo'
    );
  }
  if (assetClass === 'stock') {
    return 'Add a stock provider to STOCK_PROVIDERS, or set ALPHAVANTAGE_API_KEY / TWELVEDATA_API_KEY, then run: npm run providers:verify';
  }
  return 'Check CRYPTO_PROVIDER and BINANCE_BASE_URL, then run: npm run providers:verify';
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

/**
 * Translate the internal canonical symbol into the form a specific provider
 * expects. The rest of the app stores one canonical symbol per asset (e.g.
 * "BBCA" on exchange IDX) and never learns a vendor's naming scheme.
 */
export function providerSymbol(
  canonicalSymbol: string,
  exchangeId: string,
  providerId: string,
): string {
  if (exchangeId === 'IDX') {
    const bare = canonicalSymbol.replace(/\.JK$/i, '').replace(/:IDX$/i, '');
    if (providerId === 'yahoo') return `${bare}.JK`;
    if (providerId === 'twelvedata') return `${bare}:IDX`;
    return bare;
  }
  return canonicalSymbol;
}
