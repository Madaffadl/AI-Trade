/**
 * Core domain types. Deliberately provider-agnostic: nothing here mentions
 * Binance, Nasdaq, Yahoo or any vendor payload shape.
 *
 * This module is import-safe from client components (types + pure helpers only).
 */

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TRADING_STYLES = ['scalping', 'day', 'swing', 'position'] as const;
export type TradingStyle = (typeof TRADING_STYLES)[number];

export type AssetClass = 'crypto' | 'stock';

export const SIGNAL_ACTIONS = ['BUY', 'SELL', 'HOLD', 'WAIT'] as const;
export type SignalAction = (typeof SIGNAL_ACTIONS)[number];

export const SETUP_STRENGTHS = ['insufficient', 'weak', 'moderate', 'strong'] as const;
export type SetupStrength = (typeof SETUP_STRENGTHS)[number];

export const MARKET_REGIMES = [
  'uptrend',
  'downtrend',
  'sideways',
  'high_volatility',
  'low_volatility',
  'uncertain',
] as const;
export type MarketRegime = (typeof MARKET_REGIMES)[number];

/**
 * Data quality is a first-class concept: every downstream consumer must be able
 * to refuse to act on degraded data rather than silently producing a signal.
 */
export type DataQuality = 'ok' | 'delayed' | 'stale' | 'insufficient' | 'invalid' | 'unavailable';

export interface Candle {
  /** Candle START, epoch ms UTC (exchange clock). */
  openTimeMs: number;
  /** Candle END, epoch ms UTC. Never equal to fetchedAtMs. */
  closeTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** null when the provider genuinely supplies no volume (not 0). */
  volume: number | null;
  trades?: number | null;
  /** True while the bar's period has not finished. */
  isPartial: boolean;
}

export interface CandleSeries {
  symbol: string;
  exchangeId: string;
  assetClass: AssetClass;
  timeframe: Timeframe;
  candles: Candle[];
  provider: string;
  /** When WE retrieved this data. Distinct from any candle timestamp. */
  fetchedAtMs: number;
  quality: DataQuality;
  /** Human-readable notes, e.g. "provider returns 15-minute delayed data". */
  notes: string[];
}

export interface AssetRef {
  id: string;
  symbol: string;
  displayName: string;
  assetClass: AssetClass;
  exchangeId: string;
  currency: string;
  tickSize: number | null;
  lotSize: number | null;
  minNotional: number | null;
}

/** Milliseconds in one bar of the given timeframe. */
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

/**
 * Timeframes offered per trading style. These are starting configurations:
 * a timeframe is only *enabled* at runtime if a provider actually supports it
 * and the data is fresh enough (see market/freshness.ts).
 */
export const STYLE_TIMEFRAMES: Record<TradingStyle, Timeframe[]> = {
  scalping: ['1m', '5m', '15m'],
  day: ['5m', '15m', '1h'],
  swing: ['1h', '4h', '1d'],
  position: ['1d', '1w'],
};

export function isTimeframe(v: unknown): v is Timeframe {
  return typeof v === 'string' && (TIMEFRAMES as readonly string[]).includes(v);
}

export function isTradingStyle(v: unknown): v is TradingStyle {
  return typeof v === 'string' && (TRADING_STYLES as readonly string[]).includes(v);
}

/** Default style for a timeframe (used when the UI only knows the timeframe). */
export function styleForTimeframe(tf: Timeframe): TradingStyle {
  for (const style of TRADING_STYLES) {
    if (STYLE_TIMEFRAMES[style].includes(tf)) return style;
  }
  return 'swing';
}
