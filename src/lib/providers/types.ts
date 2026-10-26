import type { AssetClass, CandleSeries, Timeframe } from '@/lib/market/types';

/**
 * Provider adapter contracts.
 *
 * Every adapter declares its real coverage and limitations as data, so the UI
 * can display them truthfully instead of the app pretending all providers are
 * equivalent.
 */

export interface SymbolInfo {
  symbol: string;
  displayName: string;
  exchangeId: string;
  assetClass: AssetClass;
  currency: string;
  tickSize?: number | null;
  lotSize?: number | null;
  minNotional?: number | null;
}

export interface CandleRequest {
  symbol: string;
  timeframe: Timeframe;
  /** Number of bars requested, most recent first in time order. */
  limit: number;
  signal?: AbortSignal;
}

export type DataDelay =
  | { kind: 'realtime' }
  | { kind: 'delayed'; minutes: number }
  | { kind: 'end_of_day' }
  | { kind: 'unknown' };

export interface ProviderCapabilities {
  /** Exchanges/markets this adapter genuinely covers. */
  markets: string[];
  timeframes: Timeframe[];
  delay: DataDelay;
  /** Documented free-tier quota, or null when the provider publishes none. */
  quota: string | null;
  /** Honest, user-facing caveats. Rendered verbatim in Settings. */
  limitations: string[];
  /** Whether this adapter has been exercised against the live API by the author. */
  verified: boolean;
  docsUrl: string;
}

export interface MarketDataProvider {
  readonly id: string;
  readonly label: string;
  readonly assetClass: AssetClass;
  readonly requiresKey: boolean;
  readonly capabilities: ProviderCapabilities;
  /** False when a required API key is absent. */
  isConfigured(): boolean;
  supportsTimeframe(tf: Timeframe): boolean;
  fetchCandles(req: CandleRequest): Promise<CandleSeries>;
  searchSymbols?(query: string): Promise<SymbolInfo[]>;
}

export interface NewsItem {
  headline: string;
  url: string;
  publisher: string;
  feedId: string;
  publishedAtMs: number | null;
  summary: string | null;
  rawExcerpt: string | null;
}

export interface NewsProvider {
  readonly id: string;
  readonly label: string;
  isConfigured(): boolean;
  fetchLatest(limit: number): Promise<NewsItem[]>;
}
