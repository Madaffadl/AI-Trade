import 'server-only';
import { candleBounds, getSetting, saveCandles, setSetting } from '@/lib/db/repo';
import { TIMEFRAME_MS, type AssetRef, type Timeframe } from '@/lib/market/types';
import { fetchHistoryRange } from './api';

/**
 * Fill stored candles back to `days` ago, and forward to now, for validation.
 *
 * Indodax returns ~650 candles per request, so older history is paged. A pair
 * listed recently simply has no older data; the earliest date actually
 * available is remembered ("floor") so later runs do not ask again.
 */

const FLOOR_KEY = 'history.floor';

export async function backfillCandles(asset: AssetRef, timeframe: Timeframe, days: number): Promise<number> {
  const step = TIMEFRAME_MS[timeframe];
  const now = Date.now();
  const from = now - days * 86_400_000;
  const pages = (fromMs: number, toMs: number) => Math.ceil((toMs - fromMs) / step / 600) + 2;
  const floors = await getSetting<Record<string, number>>(FLOOR_KEY, {});
  const key = `${asset.id}|${timeframe}`;
  const bounds = await candleBounds(asset.id, timeframe);
  let saved = 0;

  const floor = floors[key];
  const needsOlder = bounds.minOpenMs === null || bounds.minOpenMs > from + step;
  if (needsOlder && !(floor !== undefined && bounds.minOpenMs !== null && bounds.minOpenMs <= floor + step)) {
    const to = bounds.minOpenMs ?? now;
    const older = await fetchHistoryRange(asset.symbol, timeframe, from, to, { maxPages: pages(from, to) });
    saved += await saveCandles(asset.id, timeframe, older, 'indodax', now);
    const earliest = older[0]?.openTimeMs ?? bounds.minOpenMs ?? to;
    if (earliest > from + step) await setSetting(FLOOR_KEY, { ...floors, [key]: earliest });
  }

  if (bounds.maxOpenMs !== null && now - bounds.maxOpenMs > step) {
    const recent = await fetchHistoryRange(asset.symbol, timeframe, bounds.maxOpenMs, now, { maxPages: pages(bounds.maxOpenMs, now) });
    saved += await saveCandles(asset.id, timeframe, recent, 'indodax', now);
  }
  return saved;
}
