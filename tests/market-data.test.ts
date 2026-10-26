import { describe, expect, it } from 'vitest';
import { normalizeCandles, markPartial, closedOnly } from '@/lib/market/normalize';
import { assessFreshness, canGenerateSignals } from '@/lib/market/freshness';
import { sessionState, localParts, isRegularUsSession } from '@/lib/market/sessions';
import type { Candle } from '@/lib/market/types';
import { TIMEFRAME_MS } from '@/lib/market/types';

const HOUR = TIMEFRAME_MS['1h'];

function candle(openTimeMs: number, close = 100, overrides: Partial<Candle> = {}): Candle {
  return {
    openTimeMs,
    closeTimeMs: openTimeMs + HOUR,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
    isPartial: false,
    ...overrides,
  };
}

describe('normalizeCandles', () => {
  it('drops candles whose OHLC invariants are violated', () => {
    const bad = candle(HOUR, 100, { high: 50 }); // high below open/close
    const report = normalizeCandles([candle(0), bad, candle(2 * HOUR)], '1h');
    expect(report.invalidDropped).toBe(1);
    expect(report.candles).toHaveLength(2);
  });

  it('drops non-finite and non-positive prices', () => {
    const report = normalizeCandles(
      [candle(0, Number.NaN), candle(HOUR, -5), candle(2 * HOUR, 100)],
      '1h',
    );
    expect(report.invalidDropped).toBe(2);
    expect(report.candles).toHaveLength(1);
  });

  it('collapses duplicate timestamps keeping the later arrival', () => {
    const report = normalizeCandles([candle(0, 100), candle(0, 105)], '1h');
    expect(report.duplicatesRemoved).toBe(1);
    expect(report.candles).toHaveLength(1);
    expect(report.candles[0]!.close).toBe(105);
  });

  it('re-sorts out-of-order responses and reports it', () => {
    const report = normalizeCandles([candle(2 * HOUR), candle(0), candle(HOUR)], '1h');
    expect(report.reordered).toBe(true);
    expect(report.candles.map((c) => c.openTimeMs)).toEqual([0, HOUR, 2 * HOUR]);
  });

  it('reports intraday gaps WITHOUT fabricating flat candles', () => {
    // Bars at 0 and 3h: two bars are missing.
    const report = normalizeCandles([candle(0), candle(3 * HOUR)], '1h');
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]!.missingBars).toBe(2);
    // The critical assertion: the hole is NOT filled.
    expect(report.candles).toHaveLength(2);
    expect(report.warnings.join(' ')).toMatch(/NOT filled/i);
  });

  it('does not treat weekend holes in daily data as gaps', () => {
    const day = TIMEFRAME_MS['1d'];
    const report = normalizeCandles(
      [candle(0), { ...candle(3 * day), closeTimeMs: 4 * day }],
      '1d',
    );
    expect(report.gaps).toHaveLength(0);
  });

  it('does not mutate the input array', () => {
    const input = [candle(HOUR), candle(0)];
    const snapshot = JSON.stringify(input);
    normalizeCandles(input, '1h');
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('markPartial / closedOnly', () => {
  it('marks only the bar whose period has not elapsed', () => {
    const now = 3 * HOUR + 60_000; // one minute into the 4th bar
    const marked = markPartial([candle(0), candle(HOUR), candle(2 * HOUR), candle(3 * HOUR)], '1h', now);
    expect(marked.slice(0, 3).every((c) => !c.isPartial)).toBe(true);
    expect(marked[3]!.isPartial).toBe(true);
    expect(closedOnly(marked)).toHaveLength(3);
  });
});

describe('assessFreshness', () => {
  const bars = Array.from({ length: 60 }, (_, i) => candle(i * HOUR));

  it('is ok when the last closed bar is recent', () => {
    const now = 60 * HOUR;
    const r = assessFreshness(bars, '1h', now, { minBars: 50 });
    expect(r.quality).toBe('ok');
    expect(canGenerateSignals(r.quality)).toBe(true);
  });

  it('is stale when the last bar is far older than tolerance', () => {
    const now = 60 * HOUR + 10 * HOUR;
    const r = assessFreshness(bars, '1h', now, { minBars: 50, marketOpen: true });
    expect(r.quality).toBe('stale');
    expect(canGenerateSignals(r.quality)).toBe(false);
  });

  it('reports delayed rather than stale when the market is closed', () => {
    const now = 60 * HOUR + 10 * HOUR;
    const r = assessFreshness(bars, '1h', now, { minBars: 50, marketOpen: false });
    expect(r.quality).toBe('delayed');
    expect(canGenerateSignals(r.quality)).toBe(false);
  });

  it('is insufficient when there are fewer bars than the strategy needs', () => {
    const r = assessFreshness(bars.slice(0, 10), '1h', 60 * HOUR, { minBars: 50 });
    expect(r.quality).toBe('insufficient');
  });

  it('is unavailable for an empty series', () => {
    expect(assessFreshness([], '1h', 0, { minBars: 1 }).quality).toBe('unavailable');
  });

  it('is invalid when the provider clock is ahead of ours', () => {
    const r = assessFreshness(bars, '1h', 0, { minBars: 50 });
    expect(r.quality).toBe('invalid');
  });

  it('only allows signal generation on ok data', () => {
    for (const q of ['delayed', 'stale', 'insufficient', 'invalid', 'unavailable'] as const) {
      expect(canGenerateSignals(q)).toBe(false);
    }
  });
});

describe('exchange sessions', () => {
  it('treats crypto exchanges as always open', () => {
    const s = sessionState('BINANCE', Date.UTC(2026, 0, 4, 3, 0)); // a Sunday
    expect(s.open).toBe(true);
  });

  it('applies US daylight saving correctly', () => {
    // 2026-07-01 13:30 UTC = 09:30 EDT (summer, UTC-4) -> open.
    expect(isRegularUsSession(Date.UTC(2026, 6, 1, 13, 30))).toBe(true);
    // 2026-07-01 13:00 UTC = 09:00 EDT -> before the open.
    expect(isRegularUsSession(Date.UTC(2026, 6, 1, 13, 0))).toBe(false);
    // 2026-01-05 14:30 UTC = 09:30 EST (winter, UTC-5) -> open.
    expect(isRegularUsSession(Date.UTC(2026, 0, 5, 14, 30))).toBe(true);
    // 2026-01-05 14:00 UTC = 09:00 EST -> before the open.
    expect(isRegularUsSession(Date.UTC(2026, 0, 5, 14, 0))).toBe(false);
  });

  it('reports the US weekend as closed', () => {
    const s = sessionState('US', Date.UTC(2026, 0, 3, 15, 0)); // Saturday
    expect(s.open).toBe(false);
    expect(s.open === false && s.phase).toBe('weekend');
  });

  it('identifies the US pre-market as extended hours, not regular', () => {
    const s = sessionState('US', Date.UTC(2026, 0, 5, 13, 0)); // 08:00 EST
    expect(s.open).toBe(true);
    expect(s.open && s.phase).toBe('extended');
  });

  it('handles the IDX midday break in Asia/Jakarta', () => {
    // 2026-01-05 05:00 UTC = 12:00 WIB -> between sessions.
    const between = sessionState('IDX', Date.UTC(2026, 0, 5, 5, 30));
    expect(between.open).toBe(false);
    // 2026-01-05 03:00 UTC = 10:00 WIB -> session I.
    expect(sessionState('IDX', Date.UTC(2026, 0, 5, 3, 0)).open).toBe(true);
  });

  it('honours a configured holiday', () => {
    const newYear = Date.UTC(2026, 0, 1, 15, 0); // Thursday
    expect(sessionState('US', newYear).open).toBe(true);
    const s = sessionState('US', newYear, ['2026-01-01']);
    expect(s.open).toBe(false);
    expect(s.open === false && s.phase).toBe('holiday');
  });

  it('converts instants into the correct local wall clock', () => {
    const p = localParts(Date.UTC(2026, 0, 5, 14, 30), 'America/New_York');
    expect(p.isoDate).toBe('2026-01-05');
    expect(p.minutes).toBe(9 * 60 + 30);
    expect(p.weekday).toBe(1); // Monday
  });
});
