import type { ScanDecision } from './repo';
import type { SetupState } from './types';

/**
 * The home-screen decision, first match wins:
 *   DATA_UNAVAILABLE  no pair had usable candles
 *   DAILY_STOP        today's realised loss reached the daily limit
 *   POSITIONS_FULL    the maximum number of open positions is held
 *   BUY_NOW / WAIT_FOR_ENTRY  the state of the best-ranked setup
 *   NO_TRADE          otherwise
 *
 * Used by the scan and again by the live monitor, whose fresher quotes can
 * move the best setup between BUY NOW and WAIT FOR ENTRY between scans.
 */
export function decide(i: {
  pairsWithData: number;
  dailyLossPercent: number;
  maxDailyLossPercent: number;
  openPositions: number;
  maxOpenPositions: number;
  topState: SetupState | null;
}): ScanDecision {
  if (i.pairsWithData === 0) return 'DATA_UNAVAILABLE';
  if (i.dailyLossPercent >= i.maxDailyLossPercent) return 'DAILY_STOP';
  if (i.openPositions >= i.maxOpenPositions) return 'POSITIONS_FULL';
  if (i.topState === 'BUY_NOW') return 'BUY_NOW';
  if (i.topState === 'WAIT_FOR_ENTRY') return 'WAIT_FOR_ENTRY';
  return 'NO_TRADE';
}
