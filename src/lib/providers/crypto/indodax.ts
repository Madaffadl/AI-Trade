import 'server-only';
import type { CandleSeries, Timeframe } from '@/lib/market/types';
import { cleanSymbol, fetchPairs, fetchRecentCandles, INDODAX_TF, indodaxTickerId } from '@/lib/indodax/api';
import { httpJson, ProviderError } from '../http';
import type { CandleRequest, MarketDataProvider, ProviderCapabilities, SymbolInfo } from '../types';

/**
 * Indodax - Indonesian crypto exchange, official public API.
 *
 * Verified live on 2026-10-23: ticker, OHLC history and the pair list all
 * respond without a key.
 *
 * Why this matters more than Binance for an Indonesian user: Indodax quotes in
 * IDR, which is what you actually pay. A BTC price of 81,540 USDT on Binance
 * and 1,470,223,000 IDR on Indodax are the same asset at different venues in
 * different currencies - comparing your fill against the wrong one is how you
 * end up misjudging a trade.
 */

export class IndodaxProvider implements MarketDataProvider {
  readonly id = 'indodax';
  readonly label = 'Indodax (official public API, IDR pairs)';
  readonly assetClass = 'crypto' as const;
  readonly requiresKey = false;

  readonly capabilities: ProviderCapabilities = {
    markets: ['INDODAX spot (IDR-quoted crypto)'],
    timeframes: ['1m', '5m', '15m', '1h', '4h', '1d', '1w'],
    delay: { kind: 'realtime' },
    quota: 'Public endpoints; documented limit 180 requests/minute.',
    limitations: [
      'Prices are quoted in IDR and reflect the Indodax order book only - they differ from global USD/USDT venues by local premium and spread.',
      'Liquidity on some IDR pairs is thin, so wicks and spreads can be wide. Treat small-cap IDR pairs with care.',
      'The OHLC endpoint is the exchange’s TradingView datafeed; it is public but not formally documented as a product API.',
    ],
    verified: true,
    docsUrl: 'https://github.com/btcid/indodax-official-api-docs',
  };

  isConfigured(): boolean {
    return true;
  }

  supportsTimeframe(tf: Timeframe): boolean {
    return INDODAX_TF[tf] !== undefined;
  }

  async fetchCandles(req: CandleRequest): Promise<CandleSeries> {
    if (!INDODAX_TF[req.timeframe]) throw new ProviderError(`Indodax does not support ${req.timeframe}.`, 'not_supported');
    const limit = Math.min(Math.max(req.limit, 1), 2000);
    const { candles, warnings, fetchedAtMs } = await fetchRecentCandles(req.symbol, req.timeframe, limit, req.signal);
    return {
      symbol: cleanSymbol(req.symbol),
      exchangeId: 'INDODAX',
      assetClass: 'crypto',
      timeframe: req.timeframe,
      candles,
      provider: this.id,
      fetchedAtMs,
      quality: 'ok',
      notes: [...warnings, 'Quoted in IDR on the Indodax order book.'],
    };
  }

  /** Latest ticker, useful for a quick sanity check against your fill price. */
  async fetchTicker(symbol: string): Promise<{ last: number; buy: number; sell: number; serverTimeMs: number }> {
    const raw = await httpJson<{
      ticker: { last: string; buy: string; sell: string; server_time: number };
    }>(`https://indodax.com/api/ticker/${indodaxTickerId(symbol)}`, { timeoutMs: 15_000 });
    if (!raw?.ticker) throw new ProviderError('Indodax ticker payload was empty.', 'bad_payload');
    return {
      last: Number(raw.ticker.last),
      buy: Number(raw.ticker.buy),
      sell: Number(raw.ticker.sell),
      serverTimeMs: Number(raw.ticker.server_time) * 1000,
    };
  }

  async searchSymbols(query: string): Promise<SymbolInfo[]> {
    const q = query.trim().toUpperCase();
    return (await fetchPairs())
      .filter((p) => p.symbol.includes(q) || p.description.toUpperCase().includes(q))
      .slice(0, 25)
      .map((p) => ({
        symbol: p.symbol,
        displayName: p.description,
        exchangeId: 'INDODAX',
        assetClass: 'crypto' as const,
        currency: p.quote || 'IDR',
        // Real exchange increments, so position sizing rounds honestly:
        // lotSize is the quantity STEP, minNotional the minimum order value.
        lotSize: p.quantityIncrement,
        minNotional: p.minOrderValue,
        tickSize: p.priceIncrement,
      }));
  }
}
