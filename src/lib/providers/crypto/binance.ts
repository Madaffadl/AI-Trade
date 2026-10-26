import 'server-only';
import { env } from '@/lib/config/env';
import type { Candle, CandleSeries, Timeframe } from '@/lib/market/types';
import { markPartial, normalizeCandles } from '@/lib/market/normalize';
import { httpJson, ProviderError } from '../http';
import type { CandleRequest, MarketDataProvider, ProviderCapabilities, SymbolInfo } from '../types';

/**
 * Binance public spot market data.
 *
 * Verified live on 2026-10-22 against GET /api/v3/klines (no API key, no
 * authentication). Binance blocks some jurisdictions (notably the US) at the
 * network level; BINANCE_BASE_URL can be pointed at a regional host, which has
 * different symbol coverage.
 */

const TF_MAP: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1w': '1w',
};

/** [openTime, open, high, low, close, volume, closeTime, ...] */
type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

interface ExchangeInfo {
  symbols: {
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
    filters: { filterType: string; tickSize?: string; stepSize?: string; minNotional?: string }[];
  }[];
}

export class BinanceProvider implements MarketDataProvider {
  readonly id = 'binance';
  readonly label = 'Binance (spot, public API)';
  readonly assetClass = 'crypto' as const;
  readonly requiresKey = false;

  readonly capabilities: ProviderCapabilities = {
    markets: ['BINANCE spot'],
    timeframes: ['1m', '5m', '15m', '1h', '4h', '1d', '1w'],
    delay: { kind: 'realtime' },
    quota: 'Weight-based IP limit (6000/min at time of writing); each klines call costs weight 2.',
    limitations: [
      'Public endpoint - no authentication, no guaranteed SLA for personal use.',
      'Access is blocked from some jurisdictions, including the US. Set BINANCE_BASE_URL to a regional host if needed.',
      'Quote currency is a stablecoin (e.g. USDT), not USD. Treat USDT prices as approximately-USD, not USD.',
      'Only spot markets are exposed by this adapter.',
    ],
    verified: true,
    docsUrl: 'https://developers.binance.com/docs/binance-spot-api-docs',
  };

  private base(): string {
    return env().BINANCE_BASE_URL.replace(/\/$/, '');
  }

  isConfigured(): boolean {
    return true;
  }

  supportsTimeframe(tf: Timeframe): boolean {
    return tf in TF_MAP;
  }

  async fetchCandles(req: CandleRequest): Promise<CandleSeries> {
    const interval = TF_MAP[req.timeframe];
    if (!interval) {
      throw new ProviderError(`Binance does not support timeframe ${req.timeframe}`, 'not_supported');
    }
    const limit = Math.min(Math.max(req.limit, 1), 1000);
    const url = `${this.base()}/api/v3/klines?symbol=${encodeURIComponent(req.symbol)}&interval=${interval}&limit=${limit}`;

    const fetchedAtMs = Date.now();
    const raw = await httpJson<RawKline[]>(url, { signal: req.signal });

    if (!Array.isArray(raw)) {
      throw new ProviderError('Binance returned an unexpected payload shape.', 'bad_payload');
    }

    const parsed: Candle[] = raw.map((k) => ({
      openTimeMs: Number(k[0]),
      // Binance closeTime is the last millisecond of the bar; +1 makes it an
      // exclusive end so bar arithmetic stays clean.
      closeTimeMs: Number(k[6]) + 1,
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      isPartial: false,
    }));

    const report = normalizeCandles(parsed, req.timeframe);
    const candles = markPartial(report.candles, req.timeframe, fetchedAtMs);

    return {
      symbol: req.symbol,
      exchangeId: 'BINANCE',
      assetClass: 'crypto',
      timeframe: req.timeframe,
      candles,
      provider: this.id,
      fetchedAtMs,
      quality: 'ok',
      notes: report.warnings,
    };
  }

  async searchSymbols(query: string): Promise<SymbolInfo[]> {
    // exchangeInfo is an ~18 MB reference document and keeps growing, so it
    // needs the same raised cap the catalogue builder uses. Without it this
    // call threw "Response too large" on EVERY query, which made crypto
    // symbol search fail outright.
    const info = await httpJson<ExchangeInfo>(`${this.base()}/api/v3/exchangeInfo`, {
      timeoutMs: 60_000,
      maxBytes: 48 * 1024 * 1024,
    });
    const q = query.trim().toUpperCase();
    return info.symbols
      .filter((s) => s.status === 'TRADING' && s.symbol.includes(q))
      .slice(0, 25)
      .map((s) => {
        const tick = s.filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize;
        const step = s.filters.find((f) => f.filterType === 'LOT_SIZE')?.stepSize;
        const minNotional = s.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL')?.minNotional;
        return {
          symbol: s.symbol,
          displayName: `${s.baseAsset}/${s.quoteAsset}`,
          exchangeId: 'BINANCE',
          assetClass: 'crypto' as const,
          currency: s.quoteAsset,
          tickSize: tick ? Number(tick) : null,
          lotSize: step ? Number(step) : null,
          minNotional: minNotional ? Number(minNotional) : null,
        };
      });
  }
}
