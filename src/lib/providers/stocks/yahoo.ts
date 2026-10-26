import 'server-only';
import { env } from '@/lib/config/env';
import type { Candle, CandleSeries, Timeframe } from '@/lib/market/types';
import { TIMEFRAME_MS } from '@/lib/market/types';
import { markPartial, normalizeCandles } from '@/lib/market/normalize';
import { httpJson, ProviderError } from '../http';
import type { CandleRequest, MarketDataProvider, ProviderCapabilities } from '../types';

/**
 * Yahoo Finance chart endpoint - UNOFFICIAL, OPT-IN, UNVERIFIED.
 *
 * Why it exists: at the time of writing it is the only free source observed to
 * return Indonesian (IDX) candles, via the ".JK" suffix (e.g. BBCA.JK).
 *
 * What was actually observed on 2026-10-22 from the development machine:
 *   - The first request for BBCA.JK succeeded and returned IDR-denominated
 *     daily data from the "JKT" exchange.
 *   - Every subsequent request, including the documented cookie/crumb warm-up,
 *     returned HTTP 429 and never recovered.
 *
 * It is therefore treated as unverified and is DISABLED by default. Enable it
 * only with ENABLE_YAHOO_PROVIDER=true, knowing it is an undocumented endpoint
 * with no API contract and aggressive per-IP rate limiting.
 */

const INTERVAL: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '1h', // Yahoo has no 4h bar; see supportsTimeframe - 4h is refused.
  '1d': '1d',
  '1w': '1wk',
};

/** Yahoo caps intraday history; request a range the endpoint will honour. */
function rangeFor(tf: Timeframe): string {
  switch (tf) {
    case '1m':
      return '7d';
    case '5m':
    case '15m':
      return '60d';
    case '1h':
      return '730d';
    case '1d':
      return '5y';
    default:
      return '10y';
  }
}

interface ChartResponse {
  chart: {
    result?: {
      meta: { symbol: string; currency: string; exchangeName: string; regularMarketTime?: number; gmtoffset?: number };
      timestamp?: number[];
      indicators: {
        quote?: {
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }[];
      };
    }[];
    error?: { code: string; description: string } | null;
  };
}

export class YahooProvider implements MarketDataProvider {
  readonly id = 'yahoo';
  readonly label = 'Yahoo Finance (unofficial endpoint)';
  readonly assetClass = 'stock' as const;
  readonly requiresKey = false;

  readonly capabilities: ProviderCapabilities = {
    markets: ['US equities', 'IDX / Jakarta via the .JK suffix', 'most global exchanges Yahoo lists'],
    timeframes: ['1m', '5m', '15m', '1h', '1d', '1w'],
    delay: { kind: 'unknown' },
    quota: 'Undocumented and aggressively rate-limited per IP.',
    limitations: [
      'UNOFFICIAL and UNDOCUMENTED. There is no API contract, no SLA, and no guarantee this keeps working.',
      'Observed behaviour on the development machine: one successful request, then persistent HTTP 429 - the integration remains UNVERIFIED.',
      'Disabled unless ENABLE_YAHOO_PROVIDER=true is set explicitly.',
      'No 4h bars; 4h requests are refused rather than silently served as 1h.',
      'Delay characteristics vary per exchange and are not disclosed by the endpoint.',
      'Review Yahoo’s terms before relying on this for anything beyond personal research.',
    ],
    verified: false,
    docsUrl: 'https://finance.yahoo.com/',
  };

  isConfigured(): boolean {
    return env().ENABLE_YAHOO_PROVIDER;
  }

  supportsTimeframe(tf: Timeframe): boolean {
    return tf !== '4h';
  }

  async fetchCandles(req: CandleRequest): Promise<CandleSeries> {
    if (!this.isConfigured()) {
      throw new ProviderError(
        'Yahoo provider is disabled. Set ENABLE_YAHOO_PROVIDER=true to opt in to this unofficial endpoint.',
        'not_configured',
      );
    }
    if (!this.supportsTimeframe(req.timeframe)) {
      throw new ProviderError('Yahoo does not provide 4h bars.', 'not_supported');
    }

    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(req.symbol)}` +
      `?range=${rangeFor(req.timeframe)}&interval=${INTERVAL[req.timeframe]}&includePrePost=false`;

    const fetchedAtMs = Date.now();
    const raw = await httpJson<ChartResponse>(url, {
      signal: req.signal,
      timeoutMs: 20_000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
    });

    if (raw.chart?.error) {
      throw new ProviderError(`Yahoo error: ${raw.chart.error.description}`, 'bad_payload');
    }
    const result = raw.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const stamps = result?.timestamp;
    if (!result || !quote || !stamps) {
      throw new ProviderError('Yahoo returned no usable series.', 'bad_payload');
    }

    const step = TIMEFRAME_MS[req.timeframe];
    const parsed: Candle[] = [];
    for (let i = 0; i < stamps.length; i++) {
      const o = quote.open?.[i];
      const h = quote.high?.[i];
      const l = quote.low?.[i];
      const c = quote.close?.[i];
      // Yahoo pads gaps with nulls. Those bars are skipped, not interpolated.
      if (o == null || h == null || l == null || c == null) continue;
      const openTimeMs = stamps[i]! * 1000;
      const v = quote.volume?.[i];
      parsed.push({
        openTimeMs,
        closeTimeMs: openTimeMs + step,
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v == null ? null : v,
        isPartial: false,
      });
    }

    const report = normalizeCandles(parsed, req.timeframe);
    const candles = markPartial(report.candles, req.timeframe, fetchedAtMs);
    const isIdx = /\.JK$/i.test(req.symbol);

    return {
      symbol: req.symbol,
      exchangeId: isIdx ? 'IDX' : 'US',
      assetClass: 'stock',
      timeframe: req.timeframe,
      candles: candles.slice(-req.limit),
      provider: this.id,
      fetchedAtMs,
      quality: 'ok',
      notes: [
        ...report.warnings,
        `Quoted in ${result.meta.currency} on ${result.meta.exchangeName}.`,
        'Source is an unofficial Yahoo endpoint; delay characteristics are undisclosed.',
      ],
    };
  }
}
