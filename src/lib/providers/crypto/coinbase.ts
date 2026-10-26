import 'server-only';
import { env } from '@/lib/config/env';
import type { Candle, CandleSeries, Timeframe } from '@/lib/market/types';
import { TIMEFRAME_MS } from '@/lib/market/types';
import { markPartial, normalizeCandles } from '@/lib/market/normalize';
import { httpJson, ProviderError } from '../http';
import type { CandleRequest, MarketDataProvider, ProviderCapabilities, SymbolInfo } from '../types';

/**
 * Coinbase Advanced Trade public market data.
 *
 * Verified live on 2026-10-22 against
 * GET /api/v3/brokerage/market/products/{id}/candles (no key required).
 * Useful as the primary crypto source where Binance is unavailable, and as a
 * cross-check: it quotes genuine USD pairs rather than stablecoin pairs.
 */

const GRANULARITY: Partial<Record<Timeframe, string>> = {
  '1m': 'ONE_MINUTE',
  '5m': 'FIVE_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '1h': 'ONE_HOUR',
  // Coinbase exposes SIX_HOUR, not FOUR_HOUR. 4h is therefore unsupported here
  // rather than silently approximated with a different bar size.
  '1d': 'ONE_DAY',
};

interface RawCandles {
  candles: { start: string; low: string; high: string; open: string; close: string; volume: string }[];
}

interface RawProducts {
  products: {
    product_id: string;
    base_currency_id: string;
    quote_currency_id: string;
    status: string;
    quote_increment?: string;
    base_increment?: string;
    quote_min_size?: string;
  }[];
}

export class CoinbaseProvider implements MarketDataProvider {
  readonly id = 'coinbase';
  readonly label = 'Coinbase Advanced Trade (public market data)';
  readonly assetClass = 'crypto' as const;
  readonly requiresKey = false;

  readonly capabilities: ProviderCapabilities = {
    markets: ['COINBASE spot'],
    timeframes: ['1m', '5m', '15m', '1h', '1d'],
    delay: { kind: 'realtime' },
    quota: 'Public market-data endpoints; Coinbase documents 10 requests/second for public data.',
    limitations: [
      'No 4h granularity (Coinbase offers 6h instead), so 4h strategies cannot run on this provider.',
      'A single request returns at most 350 candles.',
      'Symbols use the BASE-QUOTE form, e.g. BTC-USD.',
    ],
    verified: true,
    docsUrl: 'https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getcandles',
  };

  private base(): string {
    return env().COINBASE_BASE_URL.replace(/\/$/, '');
  }

  isConfigured(): boolean {
    return true;
  }

  supportsTimeframe(tf: Timeframe): boolean {
    return GRANULARITY[tf] !== undefined;
  }

  async fetchCandles(req: CandleRequest): Promise<CandleSeries> {
    const gran = GRANULARITY[req.timeframe];
    if (!gran) {
      throw new ProviderError(
        `Coinbase does not provide ${req.timeframe} candles (no equivalent granularity).`,
        'not_supported',
      );
    }
    const limit = Math.min(Math.max(req.limit, 1), 350);
    const step = TIMEFRAME_MS[req.timeframe];
    const endSec = Math.floor(Date.now() / 1000);
    const startSec = endSec - Math.ceil((limit * step) / 1000);

    const url =
      `${this.base()}/api/v3/brokerage/market/products/${encodeURIComponent(req.symbol)}/candles` +
      `?start=${startSec}&end=${endSec}&granularity=${gran}&limit=${limit}`;

    const fetchedAtMs = Date.now();
    const raw = await httpJson<RawCandles>(url, { signal: req.signal });
    if (!raw || !Array.isArray(raw.candles)) {
      throw new ProviderError('Coinbase returned an unexpected payload shape.', 'bad_payload');
    }

    const parsed: Candle[] = raw.candles.map((c) => {
      const openTimeMs = Number(c.start) * 1000;
      return {
        openTimeMs,
        closeTimeMs: openTimeMs + step,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
        isPartial: false,
      };
    });

    // Coinbase returns newest-first; normalizeCandles re-sorts and reports it.
    const report = normalizeCandles(parsed, req.timeframe);
    const candles = markPartial(report.candles, req.timeframe, fetchedAtMs);

    return {
      symbol: req.symbol,
      exchangeId: 'COINBASE',
      assetClass: 'crypto',
      timeframe: req.timeframe,
      candles,
      provider: this.id,
      fetchedAtMs,
      quality: 'ok',
      // Newest-first ordering is normal for this API, not a data defect.
      notes: report.warnings.filter((w) => !w.includes('out of chronological order')),
    };
  }

  async searchSymbols(query: string): Promise<SymbolInfo[]> {
    const raw = await httpJson<RawProducts>(`${this.base()}/api/v3/brokerage/market/products`, {
      timeoutMs: 20_000,
    });
    const q = query.trim().toUpperCase();
    return (raw.products ?? [])
      .filter((p) => p.status === 'online' && p.product_id.includes(q))
      .slice(0, 25)
      .map((p) => ({
        symbol: p.product_id,
        displayName: `${p.base_currency_id}/${p.quote_currency_id}`,
        exchangeId: 'COINBASE',
        assetClass: 'crypto' as const,
        currency: p.quote_currency_id,
        tickSize: p.quote_increment ? Number(p.quote_increment) : null,
        lotSize: p.base_increment ? Number(p.base_increment) : null,
        minNotional: p.quote_min_size ? Number(p.quote_min_size) : null,
      }));
  }
}
