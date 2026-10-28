/**
 * Trading sessions.
 *
 * Indodax trades 24/7, so a session never closes; the only question is
 * whether the exchange is one this app serves. (Stock-exchange calendars -
 * US and IDX hours, weekends, holidays, daylight saving - were removed with
 * the stock markets on 2026-10-29.)
 */

export type SessionState =
  | { open: true; phase: 'regular'; window: string }
  | { open: false; phase: 'closed'; reason: string };

const CONTINUOUS_EXCHANGES = new Set(['INDODAX']);

export function sessionState(exchangeId: string): SessionState {
  return CONTINUOUS_EXCHANGES.has(exchangeId)
    ? { open: true, phase: 'regular', window: '24/7' }
    : { open: false, phase: 'closed', reason: `Exchange ${exchangeId} is not supported; only Indodax is.` };
}
