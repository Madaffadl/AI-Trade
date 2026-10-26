import 'server-only';
import { env } from '@/lib/config/env';
import type { Candle, CandleSeries, Timeframe } from '@/lib/market/types';
import { TIMEFRAME_MS } from '@/lib/market/types';
import { markPartial, normalizeCandles } from '@/lib/market/normalize';
import { httpJson, ProviderError } from '../http';
import type { CandleRequest, MarketDataProvider, ProviderCapabilities, SymbolInfo } from '../types';

/**
 * Twelve Data.
 *
 * PARTIALLY VERIFIED (2026-10-22):
 *   - GET /stocks?country=Indonesia&symbol=BBCA returned a real IDX entry
 *     (exchange "IDX", MIC "XIDX", currency IDR) with no key. This proves IDX
 *     symbols exist in their reference data.
 *   - GET /time_series with the `demo` key is rejected, so IDX *candle* access
 *     on the free plan COULD NOT BE VERIFIED here. It may require a paid plan.
 *
 * The adapter therefore reports IDX support as unverified and surfaces the
 * provider's own error message rather than pretending the data arrived.
 */

const INTERVAL: Record<Timeframe, string> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '1h': '1h',
  '4h': '4h',
  '1d': '1day',
  '1w': '1week',
};

interface TimeSeriesResponse {
  meta?: { symbol: string; exchange: string; currency: string; exchange_timezone: string };
  values?: { datetime: string; open: string; high: string; low: string; close: string; volume?: string }[];
  status?: string;
  code?: number;
  message?: string;
}

interface StocksResponse {
  data?: { symbol: string; name: string; currency: string; exchange: string; country: string }[];
}

export class TwelveDataProvider implements MarketDataProvider {
  readonly id = 'twelvedata';
  readonly label = 'Twelve Data';
  readonly assetClass = 'stock' as const;
  readonly requiresKey = true;

  readonly capabilities: ProviderCapabilities = {
    markets: ['US equities', 'IDX / Indonesia (reference data confirmed; candle access UNVERIFIED)'],
    timeframes: ['1m', '5m', '15m', '1h', '4h', '1d', '1w'],
    delay: { kind: 'unknown' },
    quota: 'Free plan advertised as 800 requests/day and 8 requests/minute at time of writing.',
    limitations: [
      'IDX candle access on the FREE plan is UNVERIFIED - reference data lists IDX symbols, but time_series access was not confirmed without a paid key.',
      'Free plans commonly restrict non-US exchanges; if IDX requests fail, the provider error is shown rather than substituting US data.',
      'Real-time vs delayed behaviour depends on plan and exchange licensing.',
      'Pass IDX symbols with &exchange=IDX; symbols are bare tickers (e.g. BBCA).',
    ],
    verified: false,
    docsUrl: 'https://twelvedata.com/docs',
  };

  isConfigured(): boolean {
    return env().TWELVEDATA_API_KEY !== '';
  }

  supportsTimeframe(tf: Timeframe): boolean {
    return INTERVAL[tf] !== undefined;
  }

  async fetchCandles(req: CandleRequest): Promise<CandleSeries> {
    const key = env().TWELVEDATA_API_KEY;
    if (!key) throw new ProviderError('TWELVEDATA_API_KEY is not configured.', 'not_configured');

    // "BBCA:IDX" selects an explicit exchange; a bare ticker defaults to US.
    const [ticker, exchange] = req.symbol.includes(':')
      ? (req.symbol.split(':') as [string, string])
      : ([req.symbol, undefined] as [string, string | undefined]);

    const params = new URLSearchParams({
      symbol: ticker,
      interval: INTERVAL[req.timeframe],
      outputsize: String(Math.min(Math.max(req.limit, 1), 5000)),
      apikey: key,
      timezone: 'UTC',
    });
    if (exchange) params.set('exchange', exchange);

    const fetchedAtMs = Date.now();
    const raw = await httpJson<TimeSeriesResponse>(`https://api.twelvedata.com/time_series?${params}`, {
      signal: req.signal,
      timeoutMs: 20_000,
    });

    if (raw.status === 'error' || !raw.values) {
      const code = raw.code ?? 0;
      const message = raw.message ?? 'no values returned';
      const kind = code === 429 ? 'rate_limited' : code === 401 || code === 403 ? 'not_configured' : 'bad_payload';

      // A plan restriction is the most likely failure for a non-US exchange on
      // the free tier, and it is NOT a bug in this app. Say so explicitly
      // instead of leaving the user to decode a generic provider error.
      const planRestricted =
        code === 403 ||
        /grow|pro|plan|upgrade|not available|subscription|entitle/i.test(message);
      const hint =
        planRestricted && exchange
          ? ` — this usually means your Twelve Data plan does not include the ${exchange} exchange. ` +
            `Check your plan's exchange coverage; the rest of the app is unaffected and ${exchange} will show NO DATA.`
          : '';

      throw new ProviderError(`Twelve Data error${code ? ` ${code}` : ''}: ${message}${hint}`, kind);
    }

    const step = TIMEFRAME_MS[req.timeframe];
    const parsed: Candle[] = [];
    for (const v of raw.values) {
      const openTimeMs = parseUtcStamp(v.datetime);
      if (openTimeMs === null) continue;
      const volume = v.volume === undefined ? NaN : Number(v.volume);
      parsed.push({
        openTimeMs,
        closeTimeMs: openTimeMs + step,
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close),
        volume: Number.isFinite(volume) ? volume : null,
        isPartial: false,
      });
    }

    const report = normalizeCandles(parsed, req.timeframe);
    const candles = markPartial(report.candles, req.timeframe, fetchedAtMs);

    return {
      symbol: req.symbol,
      exchangeId: exchange === 'IDX' ? 'IDX' : 'US',
      assetClass: 'stock',
      timeframe: req.timeframe,
      candles,
      provider: this.id,
      fetchedAtMs,
      quality: 'ok',
      notes: [
        ...report.warnings.filter((w) => !w.includes('out of chronological order')),
        `Quoted in ${raw.meta?.currency ?? 'unknown currency'} on ${raw.meta?.exchange ?? 'unknown exchange'}.`,
      ],
    };
  }

  /** Reference-data search. Verified working without a key. */
  async searchSymbols(query: string): Promise<SymbolInfo[]> {
    const raw = await httpJson<StocksResponse>(
      `https://api.twelvedata.com/stocks?symbol=${encodeURIComponent(query.trim())}`,
      { timeoutMs: 20_000 },
    );
    return (raw.data ?? []).slice(0, 25).map((d) => ({
      symbol: d.exchange === 'IDX' ? `${d.symbol}:IDX` : d.symbol,
      displayName: d.name,
      exchangeId: d.exchange === 'IDX' ? 'IDX' : 'US',
      assetClass: 'stock' as const,
      currency: d.currency,
    }));
  }
}

/** Twelve Data returns "YYYY-MM-DD" or "YYYY-MM-DD HH:mm:ss"; we request UTC. */
function parseUtcStamp(stamp: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(stamp.trim());
  if (!m) return null;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? '0'),
    Number(m[5] ?? '0'),
    Number(m[6] ?? '0'),
  );
}
