import 'server-only';
import type { Candle, CandleSeries, Timeframe } from '@/lib/market/types';
import { TIMEFRAME_MS } from '@/lib/market/types';
import { markPartial, normalizeCandles } from '@/lib/market/normalize';
import { httpJson, ProviderError } from '../http';
import { isRegularUsSession } from '@/lib/market/sessions';
import type { CandleRequest, MarketDataProvider, ProviderCapabilities } from '../types';

/**
 * Nasdaq's public web API (api.nasdaq.com).
 *
 * Verified live on 2026-10-22 for both endpoints used here. IMPORTANT: this is
 * the undocumented backend of nasdaq.com, not a contractual API. It needs no
 * key, but it may change or block clients without notice - see
 * docs/DATA_PROVIDER_EVALUATION.md.
 *
 * Two distinct data shapes:
 *   /historical -> true daily OHLCV bars.
 *   /chart      -> intraday LAST-PRICE ticks at 1-minute spacing, with NO
 *                  per-bar volume (the `volumeChart` field was verified to
 *                  contain prices, not volume). Intraday bars are therefore
 *                  aggregated from ticks and carry volume = null. Volume-
 *                  confirmation rules refuse to fire on null volume rather than
 *                  treating it as zero.
 */

const BASE = 'https://api.nasdaq.com/api';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://www.nasdaq.com',
  Referer: 'https://www.nasdaq.com/',
};

interface HistoricalResponse {
  data: {
    symbol: string;
    totalRecords: number;
    tradesTable?: { rows: { date: string; close: string; volume: string; open: string; high: string; low: string }[] };
  } | null;
  status?: { rCode: number; bCodeMessage?: { errorMessage: string }[] | null };
}

interface ChartResponse {
  data: {
    symbol: string;
    timeAsOf: string;
    lastSalePrice: string;
    previousClose: string;
    chart?: { x: number; y: number }[];
  } | null;
}

/** "$1,234.56" -> 1234.56 ; "35,614,130" -> 35614130 */
function parseMoney(v: string | undefined | null): number {
  if (!v) return NaN;
  return Number(v.replace(/[$,\s]/g, ''));
}

/** Nasdaq's historical rows use MM/DD/YYYY in US Eastern market dates. */
function parseUsDate(mdY: string): number | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mdY.trim());
  if (!m) return null;
  // Anchor the daily bar at 00:00 UTC of the trading date. The bar's close time
  // marks the end of that trading day.
  return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}

export class NasdaqProvider implements MarketDataProvider {
  readonly id = 'nasdaq';
  readonly label = 'Nasdaq public web API';
  readonly assetClass = 'stock' as const;
  readonly requiresKey = false;

  readonly capabilities: ProviderCapabilities = {
    markets: ['NASDAQ', 'NYSE', 'AMEX (US-listed equities)'],
    timeframes: ['5m', '15m', '1h', '1d'],
    delay: { kind: 'delayed', minutes: 15 },
    quota: 'Undocumented. Treat as a courtesy endpoint and poll conservatively.',
    limitations: [
      'Undocumented endpoint behind nasdaq.com - no API contract, no SLA, may block clients at any time.',
      'Intraday bars are aggregated from 1-minute last-price ticks: per-bar VOLUME IS NOT AVAILABLE and is reported as null, never as 0.',
      'Intraday history covers the current session only - not enough warm-up for most intraday strategies on its own.',
      'Daily bars include genuine OHLCV.',
      'Covers US-listed equities only. No Indonesian (IDX) coverage.',
      'Price display on nasdaq.com is typically 15 minutes delayed for non-subscribers.',
    ],
    verified: true,
    docsUrl: 'https://www.nasdaq.com/market-activity/stocks',
  };

  isConfigured(): boolean {
    return true;
  }

  supportsTimeframe(tf: Timeframe): boolean {
    return this.capabilities.timeframes.includes(tf);
  }

  async fetchCandles(req: CandleRequest): Promise<CandleSeries> {
    if (!this.supportsTimeframe(req.timeframe)) {
      throw new ProviderError(`Nasdaq adapter does not support ${req.timeframe}.`, 'not_supported');
    }
    return req.timeframe === '1d' ? this.fetchDaily(req) : this.fetchIntraday(req);
  }

  private async fetchDaily(req: CandleRequest): Promise<CandleSeries> {
    const limit = Math.min(Math.max(req.limit, 1), 1000);
    // Request extra calendar days to cover weekends and holidays.
    const days = Math.ceil(limit * 1.6) + 10;
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const url =
      `${BASE}/quote/${encodeURIComponent(req.symbol)}/historical` +
      `?assetclass=stocks&fromdate=${fmt(from)}&todate=${fmt(to)}&limit=${limit}`;

    const fetchedAtMs = Date.now();
    const raw = await httpJson<HistoricalResponse>(url, { headers: BROWSER_HEADERS, signal: req.signal });

    const rows = raw.data?.tradesTable?.rows;
    if (!rows || rows.length === 0) {
      const msg = raw.status?.bCodeMessage?.[0]?.errorMessage ?? 'no rows returned';
      throw new ProviderError(`Nasdaq returned no daily data for ${req.symbol} (${msg}).`, 'bad_payload');
    }

    const parsed: Candle[] = [];
    for (const r of rows) {
      const openTimeMs = parseUsDate(r.date);
      if (openTimeMs === null) continue;
      const volume = parseMoney(r.volume);
      parsed.push({
        openTimeMs,
        closeTimeMs: openTimeMs + TIMEFRAME_MS['1d'],
        open: parseMoney(r.open),
        high: parseMoney(r.high),
        low: parseMoney(r.low),
        close: parseMoney(r.close),
        volume: Number.isFinite(volume) ? volume : null,
        isPartial: false,
      });
    }

    const report = normalizeCandles(parsed, '1d');
    const candles = markPartial(report.candles, '1d', fetchedAtMs);

    return {
      symbol: req.symbol,
      exchangeId: 'US',
      assetClass: 'stock',
      timeframe: '1d',
      candles: candles.slice(-limit),
      provider: this.id,
      fetchedAtMs,
      quality: 'ok',
      notes: [...report.warnings.filter((w) => !w.includes('out of chronological order'))],
    };
  }

  private async fetchIntraday(req: CandleRequest): Promise<CandleSeries> {
    const url = `${BASE}/quote/${encodeURIComponent(req.symbol)}/chart?assetclass=stocks`;
    const fetchedAtMs = Date.now();
    const raw = await httpJson<ChartResponse>(url, { headers: BROWSER_HEADERS, signal: req.signal });

    const ticks = raw.data?.chart;
    if (!ticks || ticks.length === 0) {
      throw new ProviderError(`Nasdaq returned no intraday chart for ${req.symbol}.`, 'bad_payload');
    }

    const step = TIMEFRAME_MS[req.timeframe];
    // Keep regular-session ticks only. Pre/post-market prints are thin and
    // would distort intraday indicators if mixed into regular-hours bars.
    const regular = ticks.filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y) && isRegularUsSession(t.x));
    const dropped = ticks.length - regular.length;

    const buckets = new Map<number, number[]>();
    for (const t of regular) {
      const bucket = Math.floor(t.x / step) * step;
      const arr = buckets.get(bucket);
      if (arr) arr.push(t.y);
      else buckets.set(bucket, [t.y]);
    }

    const parsed: Candle[] = [...buckets.entries()].map(([openTimeMs, prices]) => ({
      openTimeMs,
      closeTimeMs: openTimeMs + step,
      open: prices[0]!,
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices[prices.length - 1]!,
      // Honest null: this endpoint supplies no per-bar volume.
      volume: null,
      isPartial: false,
    }));

    const report = normalizeCandles(parsed, req.timeframe);
    const candles = markPartial(report.candles, req.timeframe, fetchedAtMs);

    const notes = [
      ...report.warnings,
      'Intraday bars aggregated from 1-minute last-price ticks; per-bar volume is unavailable (null).',
      'Nasdaq intraday history covers the current session only.',
    ];
    if (dropped > 0) notes.push(`${dropped} pre/post-market tick(s) excluded from regular-session bars.`);

    return {
      symbol: req.symbol,
      exchangeId: 'US',
      assetClass: 'stock',
      timeframe: req.timeframe,
      candles: candles.slice(-Math.min(req.limit, candles.length)),
      provider: this.id,
      fetchedAtMs,
      quality: 'ok',
      notes,
    };
  }
}
