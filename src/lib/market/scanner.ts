import 'server-only';
import { ensureDefaultWatchlist, listWatchlist, type WatchlistEntry } from '@/lib/db/repo';
import { at, last, pctChange } from '@/lib/indicators';
import { classifyRegime } from '@/lib/signals/regime';
import { listSignals } from '@/lib/signals/repo';
import { buildIndicators, STRATEGIES } from '@/lib/strategies';
import { closedOnly } from './normalize';
import { getSeries } from './service';
import type { DataQuality, MarketRegime, Timeframe, TradingStyle } from './types';
import { STYLE_TIMEFRAMES } from './types';

/**
 * Market scanner.
 *
 * Scans the configured WATCHLIST - not "every global asset". Claiming to scan
 * all markets would be false: the free providers used here cannot support it,
 * and the quota maths does not work.
 *
 * Each row carries the reason it was flagged, so a bullish/bearish label is
 * never presented without its evidence.
 */

export interface ScanRow {
  assetId: string;
  symbol: string;
  displayName: string;
  assetClass: string;
  exchangeId: string;
  currency: string;
  tradingStyle: string;
  timeframe: Timeframe;

  price: number | null;
  changePct: number | null;
  /** Percentage change over the last 20 closed bars. */
  change20Pct: number | null;
  volume: number | null;
  relativeVolume: number | null;
  atrPct: number | null;
  rsi: number | null;
  trend: 'bullish' | 'bearish' | 'neutral' | 'unknown';
  regime: MarketRegime;

  latestSignal: { action: string; strength: string; generatedAtMs: number; strategyId: string } | null;

  quality: DataQuality;
  provider: string | null;
  fetchedAtMs: number | null;
  fromCache: boolean;
  sessionOpen: boolean;
  sessionLabel: string;
  /** Why this row is flagged the way it is. Always populated. */
  reasons: string[];
  error: string | null;
  /** Concrete next step when this asset has no usable provider. */
  remedy: string | null;
}

function timeframeForStyle(style: string): Timeframe {
  const tfs = STYLE_TIMEFRAMES[(style as TradingStyle) in STYLE_TIMEFRAMES ? (style as TradingStyle) : 'swing'];
  const supported = tfs.filter((tf) => STRATEGIES.some((s) => s.timeframes.includes(tf)));
  return supported.at(-1) ?? tfs.at(-1)!;
}

export async function scanWatchlist(options: { timeframe?: Timeframe } = {}): Promise<ScanRow[]> {
  const watchlistId = await ensureDefaultWatchlist();
  const entries = await listWatchlist(watchlistId);
  const recentSignals = await listSignals({ limit: 200 });

  return Promise.all(entries.map((entry) => scanOne(entry, recentSignals, options.timeframe)));
}

async function scanOne(
  entry: WatchlistEntry,
  recentSignals: Awaited<ReturnType<typeof listSignals>>,
  overrideTimeframe?: Timeframe,
): Promise<ScanRow> {
  const timeframe = overrideTimeframe ?? timeframeForStyle(entry.tradingStyle);

  const row: ScanRow = {
    assetId: entry.id,
    symbol: entry.symbol,
    displayName: entry.displayName,
    assetClass: entry.assetClass,
    exchangeId: entry.exchangeId,
    currency: entry.currency,
    tradingStyle: entry.tradingStyle,
    timeframe,
    price: null,
    changePct: null,
    change20Pct: null,
    volume: null,
    relativeVolume: null,
    atrPct: null,
    rsi: null,
    trend: 'unknown',
    regime: 'uncertain',
    latestSignal: null,
    quality: 'unavailable',
    provider: null,
    fetchedAtMs: null,
    fromCache: false,
    sessionOpen: false,
    sessionLabel: '',
    reasons: [],
    error: null,
    remedy: null,
  };

  const signal = recentSignals.find((s) => s.asset_id === entry.id && s.timeframe === timeframe);
  if (signal) {
    row.latestSignal = {
      action: signal.action,
      strength: signal.strength,
      generatedAtMs: signal.generated_at_ms,
      strategyId: signal.strategy_id,
    };
  }

  try {
    const result = await getSeries(entry, timeframe, { limit: 220, minBars: 60 });
    row.quality = result.quality;
    row.provider = result.series?.provider ?? null;
    row.fetchedAtMs = result.series?.fetchedAtMs ?? null;
    row.fromCache = result.fromCache;
    row.sessionOpen = result.session.open;
    row.sessionLabel = result.session.open
      ? `open · ${'window' in result.session ? result.session.window : ''}`
      : `closed · ${'reason' in result.session ? result.session.reason : ''}`;
    row.error = result.providerError;
    row.remedy = result.remedy;

    if (!result.series || result.series.candles.length === 0) {
      row.reasons.push(result.providerError ?? 'No market data available for this asset.');
      return row;
    }

    const all = result.series.candles;
    const bars = closedOnly(all);
    // The latest price may come from the in-progress bar; the ANALYSIS never
    // does, which is why the two are read from different arrays.
    row.price = all.at(-1)?.close ?? null;
    row.volume = all.at(-1)?.volume ?? null;

    if (bars.length < 2) {
      row.reasons.push(`Only ${bars.length} closed bar(s) available.`);
      return row;
    }

    const prevClose = bars.at(-2)!.close;
    row.changePct = pctChange(prevClose, row.price ?? bars.at(-1)!.close);
    if (bars.length >= 21) row.change20Pct = pctChange(bars.at(-21)!.close, bars.at(-1)!.close);

    if (bars.length < 60) {
      row.reasons.push(`Only ${bars.length} closed bars; indicator-based classification needs at least 60.`);
      return row;
    }

    const ind = buildIndicators(bars);
    const i = bars.length - 1;
    const regime = classifyRegime(bars);
    row.regime = regime.regime;
    row.rsi = at(ind.rsi, i);
    row.relativeVolume = at(ind.volume.relativeVolume, i);

    const atrValue = at(ind.atr, i);
    const close = bars[i]!.close;
    row.atrPct = atrValue !== null && close !== 0 ? (atrValue / close) * 100 : null;

    const emaFast = at(ind.emaFast, i);
    const emaSlow = at(ind.emaSlow, i);

    if (emaFast !== null && emaSlow !== null) {
      if (emaFast > emaSlow && close > emaSlow) {
        row.trend = 'bullish';
        row.reasons.push(`EMA20 above EMA50 and price above EMA50 (${regime.regime}).`);
      } else if (emaFast < emaSlow && close < emaSlow) {
        row.trend = 'bearish';
        row.reasons.push(`EMA20 below EMA50 and price below EMA50 (${regime.regime}).`);
      } else {
        row.trend = 'neutral';
        row.reasons.push('Moving averages and price disagree on direction.');
      }
    }

    if (row.rsi !== null) {
      if (row.rsi >= 70) row.reasons.push(`RSI ${row.rsi.toFixed(1)} is in the overbought zone.`);
      else if (row.rsi <= 30) row.reasons.push(`RSI ${row.rsi.toFixed(1)} is in the oversold zone.`);
    }
    if (row.relativeVolume !== null && row.relativeVolume >= 1.5) {
      row.reasons.push(`Volume is ${row.relativeVolume.toFixed(2)}x its 20-bar average.`);
    }
    if (ind.volume.unavailable) {
      row.reasons.push('This data source supplies no per-bar volume, so volume rules are skipped.');
    }
    if (row.quality !== 'ok') {
      row.reasons.push(`Data quality is "${row.quality}" — new signals are suppressed for this asset.`);
    }
    const bandwidth = last(ind.bollinger.bandwidth);
    if (bandwidth !== null && bandwidth < 0.03) {
      row.reasons.push('Bollinger bandwidth is unusually narrow (compressed range).');
    }
  } catch (err) {
    row.error = err instanceof Error ? err.message : String(err);
    row.reasons.push(`Scan failed: ${row.error}`);
  }

  return row;
}
