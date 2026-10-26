import 'server-only';
import { env } from '@/lib/config/env';
import type { Candle, CandleSeries, Timeframe } from '@/lib/market/types';
import { TIMEFRAME_MS } from '@/lib/market/types';
import { markPartial, normalizeCandles } from '@/lib/market/normalize';
import { httpJson, ProviderError } from '../http';
import type { CandleRequest, MarketDataProvider, ProviderCapabilities } from '../types';

/**
 * Alpha Vantage.
 *
 * Verified live on 2026-10-22 using the publicly documented `demo` key, which
 * only serves IBM. A real free key is required for other symbols; the free tier
 * was 25 requests/day at the time of writing, which is a hard constraint on how
 * many stocks can be refreshed per day.
 */

const INTRADAY_INTERVAL: Partial<Record<Timeframe, string>> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '1h': '60min',
};

type SeriesPayload = Record<string, Record<string, Record<string, string>>> & {
  Note?: string;
  Information?: string;
  'Error Message'?: string;
};

export class AlphaVantageProvider implements MarketDataProvider {
  readonly id = 'alphavantage';
  readonly label = 'Alpha Vantage';
  readonly assetClass = 'stock' as const;
  readonly requiresKey = true;

  readonly capabilities: ProviderCapabilities = {
    markets: ['US equities (NASDAQ/NYSE/AMEX)'],
    timeframes: ['1m', '5m', '15m', '1h', '1d'],
    delay: { kind: 'unknown' },
    quota: 'Free tier documented as 25 requests/day at time of writing (subject to change).',
    limitations: [
      'Free tier is 25 requests/day - enough for a handful of assets refreshed a few times daily, not for scalping.',
      'The `demo` API key only returns IBM; a free key is required for any other symbol.',
      'Free-tier intraday data is not guaranteed real-time.',
      'No Indonesian (IDX) coverage on the free tier.',
      'Quota exhaustion is reported in a JSON "Information"/"Note" field with HTTP 200 - this adapter detects that and raises a rate-limit error instead of parsing it as data.',
    ],
    verified: true,
    docsUrl: 'https://www.alphavantage.co/documentation/',
  };

  isConfigured(): boolean {
    return env().ALPHAVANTAGE_API_KEY !== '';
  }

  supportsTimeframe(tf: Timeframe): boolean {
    return tf === '1d' || INTRADAY_INTERVAL[tf] !== undefined;
  }

  async fetchCandles(req: CandleRequest): Promise<CandleSeries> {
    const key = env().ALPHAVANTAGE_API_KEY;
    if (!key) {
      throw new ProviderError('ALPHAVANTAGE_API_KEY is not configured.', 'not_configured');
    }
    if (!this.supportsTimeframe(req.timeframe)) {
      throw new ProviderError(`Alpha Vantage does not support ${req.timeframe}.`, 'not_supported');
    }

    const intraday = req.timeframe !== '1d';
    const interval = INTRADAY_INTERVAL[req.timeframe];
    const outputsize = req.limit > 100 ? 'full' : 'compact';
    const url = intraday
      ? `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${encodeURIComponent(req.symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${encodeURIComponent(key)}`
      : `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(req.symbol)}&outputsize=${outputsize}&apikey=${encodeURIComponent(key)}`;

    const fetchedAtMs = Date.now();
    const raw = await httpJson<SeriesPayload>(url, { signal: req.signal, timeoutMs: 20_000 });

    // Alpha Vantage signals quota exhaustion and errors with HTTP 200.
    if (raw.Note || raw.Information) {
      throw new ProviderError(
        `Alpha Vantage quota/notice: ${(raw.Note ?? raw.Information ?? '').slice(0, 200)}`,
        'rate_limited',
        200,
      );
    }
    if (raw['Error Message']) {
      throw new ProviderError(`Alpha Vantage error: ${raw['Error Message']}`, 'bad_payload');
    }

    const seriesKey = Object.keys(raw).find((k) => k.toLowerCase().includes('time series'));
    if (!seriesKey) {
      throw new ProviderError('Alpha Vantage response contained no time series.', 'bad_payload');
    }
    const series = raw[seriesKey] as Record<string, Record<string, string>>;
    const step = TIMEFRAME_MS[req.timeframe];

    const parsed: Candle[] = [];
    for (const [stamp, values] of Object.entries(series)) {
      const openTimeMs = parseStamp(stamp, intraday);
      if (openTimeMs === null) continue;
      const volume = Number(values['5. volume']);
      parsed.push({
        openTimeMs,
        closeTimeMs: openTimeMs + step,
        open: Number(values['1. open']),
        high: Number(values['2. high']),
        low: Number(values['3. low']),
        close: Number(values['4. close']),
        volume: Number.isFinite(volume) ? volume : null,
        isPartial: false,
      });
    }

    const report = normalizeCandles(parsed, req.timeframe);
    const candles = markPartial(report.candles, req.timeframe, fetchedAtMs);

    return {
      symbol: req.symbol,
      exchangeId: 'US',
      assetClass: 'stock',
      timeframe: req.timeframe,
      candles: candles.slice(-req.limit),
      provider: this.id,
      fetchedAtMs,
      quality: 'ok',
      notes: [
        ...report.warnings.filter((w) => !w.includes('out of chronological order')),
        intraday
          ? 'Alpha Vantage intraday timestamps are US/Eastern; converted to UTC on ingest.'
          : 'Daily bars are end-of-day values.',
      ],
    };
  }
}

/**
 * Alpha Vantage returns "YYYY-MM-DD" for daily and "YYYY-MM-DD HH:mm:ss" in
 * US/Eastern for intraday. Eastern offset is resolved for the specific instant
 * so DST is handled rather than assumed.
 */
function parseStamp(stamp: string, intraday: boolean): number | null {
  if (!intraday) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(stamp);
    if (!m) return null;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(stamp);
  if (!m) return null;
  const naiveUtc = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? '0'),
  );
  return naiveUtc + easternOffsetMs(naiveUtc);
}

/** Offset to ADD to a naive US/Eastern wall-clock reading to get true UTC. */
function easternOffsetMs(approxUtcMs: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  });
  const name = fmt.formatToParts(new Date(approxUtcMs)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return 5 * 3_600_000;
  const sign = m[1] === '-' ? 1 : -1; // local = UTC + offset, so UTC = local - offset
  const hours = Number(m[2]);
  const mins = Number(m[3] ?? '0');
  return sign * (hours * 3_600_000 + mins * 60_000);
}
