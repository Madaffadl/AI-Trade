import 'server-only';
import type { Candle, CandleSeries, Timeframe } from '@/lib/market/types';
import { TIMEFRAME_MS } from '@/lib/market/types';
import { markPartial, normalizeCandles } from '@/lib/market/normalize';
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

/** Indodax's TradingView-compatible `tf` parameter. All seven are supported. */
const TF: Record<Timeframe, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': '1D',
  '1w': '1W',
};

interface RawBar {
  Time: number; // epoch SECONDS
  Open: number;
  High: number;
  Low: number;
  Close: number;
  Volume: string;
}

interface RawPair {
  ticker_id: string; // 'btc_idr'
  symbol: string; // 'BTCIDR'
  base_currency: string; // 'idr'
  traded_currency: string; // 'btc'
  traded_currency_unit: string; // 'BTC'
  description: string; // 'BTC/IDR'
  trade_min_traded_currency?: number;
  trade_min_base_currency?: number;
  price_round?: number;
}

export class IndodaxProvider implements MarketDataProvider {
  readonly id = 'indodax';
  readonly label = 'Indodax (official public API, IDR pairs)';
  readonly assetClass = 'crypto' as const;
  readonly requiresKey = false;

  readonly capabilities: ProviderCapabilities = {
    markets: ['INDODAX spot (IDR-quoted crypto)'],
    timeframes: ['1m', '5m', '15m', '1h', '4h', '1d', '1w'],
    delay: { kind: 'realtime' },
    quota: 'Public endpoints; no published quota. Poll conservatively.',
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
    return TF[tf] !== undefined;
  }

  /** 'BTCIDR' (canonical here) -> 'btc_idr' for the ticker/pairs endpoints. */
  private toTickerId(symbol: string): string {
    const s = symbol.toUpperCase().replace(/[^A-Z]/g, '');
    if (s.endsWith('IDR')) return `${s.slice(0, -3).toLowerCase()}_idr`;
    return s.toLowerCase();
  }

  async fetchCandles(req: CandleRequest): Promise<CandleSeries> {
    const tf = TF[req.timeframe];
    if (!tf) throw new ProviderError(`Indodax does not support ${req.timeframe}.`, 'not_supported');

    const step = TIMEFRAME_MS[req.timeframe];
    const limit = Math.min(Math.max(req.limit, 1), 2000);
    const nowSec = Math.floor(Date.now() / 1000);
    // Ask for a generous window; the endpoint returns whatever exists in range.
    const fromSec = nowSec - Math.ceil((limit * step) / 1000) * 2;

    const symbol = req.symbol.toUpperCase().replace(/[^A-Z]/g, '');
    const url =
      `https://indodax.com/tradingview/history_v2?from=${fromSec}&symbol=${encodeURIComponent(symbol)}&tf=${tf}&to=${nowSec}`;

    const fetchedAtMs = Date.now();
    const raw = await httpJson<RawBar[]>(url, { signal: req.signal, timeoutMs: 20_000 });

    if (!Array.isArray(raw)) {
      throw new ProviderError('Indodax returned an unexpected payload shape.', 'bad_payload');
    }
    if (raw.length === 0) {
      throw new ProviderError(
        `Indodax returned no candles for ${symbol}. Check the pair exists (e.g. BTCIDR, ETHIDR).`,
        'bad_payload',
      );
    }

    const parsed: Candle[] = raw.map((b) => {
      const openTimeMs = Number(b.Time) * 1000;
      const volume = Number(b.Volume);
      return {
        openTimeMs,
        closeTimeMs: openTimeMs + step,
        open: Number(b.Open),
        high: Number(b.High),
        low: Number(b.Low),
        close: Number(b.Close),
        volume: Number.isFinite(volume) ? volume : null,
        isPartial: false,
      };
    });

    const report = normalizeCandles(parsed, req.timeframe);
    const candles = markPartial(report.candles, req.timeframe, fetchedAtMs);

    return {
      symbol,
      exchangeId: 'INDODAX',
      assetClass: 'crypto',
      timeframe: req.timeframe,
      candles: candles.slice(-limit),
      provider: this.id,
      fetchedAtMs,
      quality: 'ok',
      notes: [...report.warnings, 'Quoted in IDR on the Indodax order book.'],
    };
  }

  /** Latest ticker, useful for a quick sanity check against your fill price. */
  async fetchTicker(symbol: string): Promise<{ last: number; buy: number; sell: number; serverTimeMs: number }> {
    const raw = await httpJson<{
      ticker: { last: string; buy: string; sell: string; server_time: number };
    }>(`https://indodax.com/api/ticker/${this.toTickerId(symbol)}`, { timeoutMs: 15_000 });
    if (!raw?.ticker) throw new ProviderError('Indodax ticker payload was empty.', 'bad_payload');
    return {
      last: Number(raw.ticker.last),
      buy: Number(raw.ticker.buy),
      sell: Number(raw.ticker.sell),
      serverTimeMs: Number(raw.ticker.server_time) * 1000,
    };
  }

  async searchSymbols(query: string): Promise<SymbolInfo[]> {
    const pairs = await httpJson<RawPair[]>('https://indodax.com/api/pairs', { timeoutMs: 25_000 });
    const q = query.trim().toUpperCase();
    return (pairs ?? [])
      .filter((p) => p.symbol?.toUpperCase().includes(q) || p.description?.toUpperCase().includes(q))
      .slice(0, 25)
      .map((p) => ({
        symbol: p.symbol.toUpperCase(),
        displayName: p.description,
        exchangeId: 'INDODAX',
        assetClass: 'crypto' as const,
        currency: p.base_currency?.toUpperCase() ?? 'IDR',
        // Real exchange minimums, so position sizing can round honestly.
        lotSize: p.trade_min_traded_currency ?? null,
        minNotional: p.trade_min_base_currency ?? null,
        tickSize: null,
      }));
  }
}
