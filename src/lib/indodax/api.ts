import 'server-only';
import { markPartial, normalizeCandles } from '@/lib/market/normalize';
import { TIMEFRAME_MS, type Candle, type Timeframe } from '@/lib/market/types';
import { httpJson, ProviderError } from '@/lib/providers/http';

/**
 * Indodax public REST API - parsing and fetching, verified live 2026-10-28.
 *
 *   /api/ticker_all            every pair in ONE request: last, buy (bid), sell (ask), vol_idr
 *   /api/pairs                 per-pair trading rules: taker/maker fee %, quantity_increment,
 *                              trade_min_base_currency (minimum order in IDR), price_precision
 *   /tradingview/history_v2    OHLCV; returns at most ~650 1h bars per request (the LATEST bars
 *                              in the window), so longer history is paged backwards.
 *
 * Documented public limit: 180 requests/minute. Nothing here needs a key.
 * Parsers are pure and drop malformed rows rather than guessing a value.
 */

const BASE = 'https://indodax.com';

/** Canonical symbol: upper-case letters AND digits ('1INCHIDR', 'API3IDR' are real pairs). */
export function cleanSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 'BTCIDR' -> 'btc_idr', '1INCHIDR' -> '1inch_idr'. */
export function indodaxTickerId(symbol: string): string {
  const s = cleanSymbol(symbol);
  return s.endsWith('IDR') ? `${s.slice(0, -3).toLowerCase()}_idr` : s.toLowerCase();
}

/** 'btc_idr' -> 'BTCIDR'. */
export function symbolFromTickerKey(key: string): string {
  return key.replace(/_/g, '').toUpperCase();
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export interface IndodaxTicker {
  symbol: string;
  last: number;
  /** Best bid - what a market SELL would receive. */
  bid: number;
  /** Best ask - what a market BUY would pay. */
  ask: number;
  high: number | null;
  low: number | null;
  /** 24h turnover in IDR; null for non-IDR pairs. */
  volumeIdr: number | null;
  serverTimeMs: number | null;
}

export function parseTickerAll(raw: unknown): IndodaxTicker[] {
  const tickers = (raw as { tickers?: unknown } | null)?.tickers;
  if (!tickers || typeof tickers !== 'object') {
    throw new ProviderError('Indodax ticker_all returned no tickers.', 'bad_payload');
  }
  const out: IndodaxTicker[] = [];
  for (const [key, value] of Object.entries(tickers as Record<string, Record<string, unknown>>)) {
    const last = num(value?.last);
    const bid = num(value?.buy);
    const ask = num(value?.sell);
    if (last === null || bid === null || ask === null) continue;
    const serverTime = num(value?.server_time);
    out.push({
      symbol: symbolFromTickerKey(key),
      last,
      bid,
      ask,
      high: num(value?.high),
      low: num(value?.low),
      volumeIdr: num(value?.vol_idr),
      serverTimeMs: serverTime === null ? null : serverTime * 1000,
    });
  }
  return out;
}

export interface IndodaxPairMeta {
  symbol: string;
  tickerId: string;
  /** e.g. 'BTC/IDR'. */
  description: string;
  /** The coin, e.g. 'BTC'. */
  asset: string;
  /** The currency it is priced in, e.g. 'IDR'. */
  quote: string;
  takerFeePct: number | null;
  makerFeePct: number | null;
  /** Smallest step an order quantity may change by. */
  quantityIncrement: number | null;
  /** Smallest order value accepted, in the quote currency (Rp10,000 on IDR pairs). */
  minOrderValue: number | null;
  minQuantity: number | null;
  /** Smallest price step. */
  priceIncrement: number | null;
  /** False while the pair is under maintenance or its market is suspended. */
  tradable: boolean;
}

export function parsePairs(raw: unknown): IndodaxPairMeta[] {
  if (!Array.isArray(raw)) throw new ProviderError('Indodax /api/pairs did not return a list.', 'bad_payload');
  const out: IndodaxPairMeta[] = [];
  for (const p of raw as Record<string, unknown>[]) {
    const symbol = typeof p?.symbol === 'string' ? cleanSymbol(p.symbol) : '';
    if (!symbol) continue;
    out.push({
      symbol,
      tickerId: typeof p.ticker_id === 'string' ? p.ticker_id : indodaxTickerId(symbol),
      description: typeof p.description === 'string' ? p.description : symbol,
      asset: String(p.traded_currency_unit ?? p.traded_currency ?? '').toUpperCase(),
      quote: String(p.base_currency ?? '').toUpperCase(),
      takerFeePct: num(p.trade_fee_percent_taker) ?? num(p.trade_fee_percent),
      makerFeePct: num(p.trade_fee_percent_maker),
      quantityIncrement: num(p.quantity_increment),
      minOrderValue: num(p.trade_min_base_currency),
      minQuantity: num(p.trade_min_traded_currency),
      priceIncrement: num(p.price_precision),
      tradable: !Number(p.is_maintenance ?? 0) && !Number(p.is_market_suspended ?? 0),
    });
  }
  return out;
}

/** Indodax's TradingView `tf` parameter. */
export const INDODAX_TF: Record<Timeframe, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': '1D',
  '1w': '1W',
};

interface RawBar {
  Time: number; // epoch SECONDS (bar open)
  Open: number;
  High: number;
  Low: number;
  Close: number;
  Volume: string;
}

export function parseBars(raw: unknown, timeframe: Timeframe): Candle[] {
  if (!Array.isArray(raw)) throw new ProviderError('Indodax returned an unexpected candle payload.', 'bad_payload');
  const step = TIMEFRAME_MS[timeframe];
  return (raw as RawBar[]).map((b) => {
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
}

function historyUrl(symbol: string, timeframe: Timeframe, fromSec: number, toSec: number): string {
  return `${BASE}/tradingview/history_v2?from=${fromSec}&symbol=${encodeURIComponent(cleanSymbol(symbol))}&tf=${INDODAX_TF[timeframe]}&to=${toSec}`;
}

export async function fetchTickerAll(): Promise<{ tickers: IndodaxTicker[]; fetchedAtMs: number }> {
  const fetchedAtMs = Date.now();
  const raw = await httpJson<unknown>(`${BASE}/api/ticker_all`, { timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024 });
  return { tickers: parseTickerAll(raw), fetchedAtMs };
}

export async function fetchPairs(): Promise<IndodaxPairMeta[]> {
  return parsePairs(await httpJson<unknown>(`${BASE}/api/pairs`, { timeoutMs: 25_000, maxBytes: 8 * 1024 * 1024 }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Candles between two times, paging backwards because one request returns
 * only the most recent ~650 bars of its window. Pauses between pages to stay
 * well inside the 180 requests/minute limit.
 */
export async function fetchHistoryRange(
  symbol: string,
  timeframe: Timeframe,
  fromMs: number,
  toMs: number,
  options: { maxPages?: number; pauseMs?: number } = {},
): Promise<Candle[]> {
  const maxPages = options.maxPages ?? 12;
  const pauseMs = options.pauseMs ?? 400;
  const fromSec = Math.floor(fromMs / 1000);
  let toSec = Math.floor(toMs / 1000);
  const byOpen = new Map<number, Candle>();

  for (let page = 0; page < maxPages && toSec > fromSec; page++) {
    if (page > 0) await sleep(pauseMs);
    const bars = parseBars(await httpJson<unknown>(historyUrl(symbol, timeframe, fromSec, toSec), { timeoutMs: 20_000 }), timeframe);
    if (bars.length === 0) break;
    for (const b of bars) byOpen.set(b.openTimeMs, b);
    const earliestSec = Math.min(...bars.map((b) => b.openTimeMs)) / 1000;
    if (earliestSec <= fromSec) break;
    toSec = earliestSec - 1;
  }

  const sorted = [...byOpen.values()].filter((c) => c.openTimeMs >= fromMs).sort((a, b) => a.openTimeMs - b.openTimeMs);
  return markPartial(normalizeCandles(sorted, timeframe).candles, timeframe, Date.now());
}

/** The most recent `limit` candles (single request, used by the regular refresh). */
export async function fetchRecentCandles(
  symbol: string,
  timeframe: Timeframe,
  limit: number,
  signal?: AbortSignal,
): Promise<{ candles: Candle[]; warnings: string[]; fetchedAtMs: number }> {
  const step = TIMEFRAME_MS[timeframe];
  const nowSec = Math.floor(Date.now() / 1000);
  // Ask for a generous window; the endpoint returns whatever exists in range.
  const fromSec = nowSec - Math.ceil((limit * step) / 1000) * 2;
  const fetchedAtMs = Date.now();
  const raw = await httpJson<unknown>(historyUrl(symbol, timeframe, fromSec, nowSec), { signal, timeoutMs: 20_000 });
  const bars = parseBars(raw, timeframe);
  if (bars.length === 0) {
    throw new ProviderError(
      `Indodax returned no candles for ${cleanSymbol(symbol)}. Check the pair exists (e.g. BTCIDR, ETHIDR).`,
      'bad_payload',
    );
  }
  const report = normalizeCandles(bars, timeframe);
  return { candles: markPartial(report.candles, timeframe, fetchedAtMs).slice(-limit), warnings: report.warnings, fetchedAtMs };
}
