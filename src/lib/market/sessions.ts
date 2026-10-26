/**
 * Exchange trading sessions.
 *
 * Timezone conversion uses Intl.DateTimeFormat with an IANA zone, which
 * correctly handles daylight saving transitions without a date library.
 *
 * HOLIDAYS: this module intentionally does NOT ship a hardcoded holiday
 * calendar. A stale or invented holiday list is worse than none, because it
 * would silently mislabel real trading days. Exchange holidays are supplied at
 * runtime via the `market.holidays` application setting (ISO dates per
 * exchange); when empty, holidays are simply unknown and the UI says so.
 */

export interface SessionWindow {
  /** Minutes from local midnight. */
  startMin: number;
  endMin: number;
  label: string;
}

export interface ExchangeSession {
  exchangeId: string;
  timezone: string;
  continuous: boolean;
  /** Index 0 = Sunday .. 6 = Saturday. */
  weekdays: number[];
  regular: SessionWindow[];
  extended: SessionWindow[];
  notes: string[];
}

const hm = (h: number, m = 0) => h * 60 + m;

export const EXCHANGE_SESSIONS: Record<string, ExchangeSession> = {
  BINANCE: {
    exchangeId: 'BINANCE',
    timezone: 'UTC',
    continuous: true,
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    regular: [{ startMin: 0, endMin: 1440, label: '24/7' }],
    extended: [],
    notes: ['Crypto spot trades continuously; liquidity still varies by hour and by pair.'],
  },
  COINBASE: {
    exchangeId: 'COINBASE',
    timezone: 'UTC',
    continuous: true,
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    regular: [{ startMin: 0, endMin: 1440, label: '24/7' }],
    extended: [],
    notes: ['Crypto spot trades continuously; liquidity still varies by hour and by pair.'],
  },
  INDODAX: {
    exchangeId: 'INDODAX',
    timezone: 'Asia/Jakarta',
    continuous: true,
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    regular: [{ startMin: 0, endMin: 1440, label: '24/7' }],
    extended: [],
    notes: ['Crypto trades continuously. IDR pair liquidity is thinnest overnight Jakarta time.'],
  },
  US: {
    exchangeId: 'US',
    timezone: 'America/New_York',
    continuous: false,
    weekdays: [1, 2, 3, 4, 5],
    regular: [{ startMin: hm(9, 30), endMin: hm(16, 0), label: 'Regular trading hours' }],
    extended: [
      { startMin: hm(4, 0), endMin: hm(9, 30), label: 'Pre-market' },
      { startMin: hm(16, 0), endMin: hm(20, 0), label: 'After-hours' },
    ],
    notes: [
      'US equity regular hours are 09:30-16:00 America/New_York, adjusted automatically for DST.',
      'Exchange holidays and early closes are not known to this app unless configured.',
    ],
  },
  IDX: {
    exchangeId: 'IDX',
    timezone: 'Asia/Jakarta',
    continuous: false,
    weekdays: [1, 2, 3, 4, 5],
    // IDX runs two sessions per day with a midday break. Friday differs.
    regular: [
      { startMin: hm(9, 0), endMin: hm(12, 0), label: 'Session I' },
      { startMin: hm(13, 30), endMin: hm(15, 50), label: 'Session II' },
    ],
    extended: [{ startMin: hm(8, 45), endMin: hm(9, 0), label: 'Pre-opening' }],
    notes: [
      'IDX trades in two sessions with a midday break; Friday session times differ from Mon-Thu.',
      'Session windows here are a configured approximation and may lag IDX rule changes - verify against idx.co.id before relying on them.',
      'Indonesian public holidays are not known to this app unless configured.',
    ],
  },
};

interface LocalParts {
  weekday: number;
  minutes: number;
  isoDate: string;
}

/** Convert an epoch-ms instant into local wall-clock parts for an IANA zone. */
export function localParts(ms: number, timezone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(parts.hour) % 24;
  return {
    weekday: weekdayMap[parts.weekday ?? 'Mon'] ?? 1,
    minutes: hour * 60 + Number(parts.minute),
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export type SessionState =
  | { open: true; phase: 'regular'; window: string }
  | { open: true; phase: 'extended'; window: string }
  | { open: false; phase: 'closed' | 'weekend' | 'holiday'; reason: string };

/**
 * Current session state for an exchange.
 * `holidays` is a list of ISO dates (YYYY-MM-DD) in the exchange's local zone.
 */
export function sessionState(
  exchangeId: string,
  nowMs: number,
  holidays: readonly string[] = [],
): SessionState {
  const cfg = EXCHANGE_SESSIONS[exchangeId];
  if (!cfg) return { open: false, phase: 'closed', reason: `Unknown exchange ${exchangeId}.` };
  if (cfg.continuous) return { open: true, phase: 'regular', window: '24/7' };

  const { weekday, minutes, isoDate } = localParts(nowMs, cfg.timezone);
  if (!cfg.weekdays.includes(weekday)) {
    return { open: false, phase: 'weekend', reason: 'Exchange is closed for the weekend.' };
  }
  if (holidays.includes(isoDate)) {
    return { open: false, phase: 'holiday', reason: `${isoDate} is a configured exchange holiday.` };
  }
  for (const w of cfg.regular) {
    if (minutes >= w.startMin && minutes < w.endMin) {
      return { open: true, phase: 'regular', window: w.label };
    }
  }
  for (const w of cfg.extended) {
    if (minutes >= w.startMin && minutes < w.endMin) {
      return { open: true, phase: 'extended', window: w.label };
    }
  }
  return { open: false, phase: 'closed', reason: 'Outside trading hours for this exchange.' };
}

/** True when the instant falls inside US regular trading hours. */
export function isRegularUsSession(ms: number): boolean {
  const s = sessionState('US', ms);
  return s.open && s.phase === 'regular';
}

/** Whether new bars should currently be expected from this exchange. */
export function expectsNewBars(exchangeId: string, nowMs: number, holidays: readonly string[] = []): boolean {
  return sessionState(exchangeId, nowMs, holidays).open;
}
