import type { SetupState, StateReason, TradePlan } from './types';

/**
 * What a plan means RIGHT NOW, given the live order book.
 *
 * Checked in this order, first match wins:
 *   EXPIRED          the entry window (3 entry bars) has passed
 *   DATA_STALE       candles are not current, or the quote is older than 10 min
 *   INVALIDATED      the bid is at or below the stop - the setup has failed.
 *                    A PENDING setup has no position yet, so its stop does not
 *                    apply; it fails when the price leaves the zone it was
 *                    detected in (below the stop AND more than 1 ATR under the
 *                    trigger) - a breakout's stop sits just under its trigger,
 *                    where a not-yet-broken-out price normally is.
 *   MISSED           the bid already reached TP1 - the move happened without us
 *   NOT_ELIGIBLE     the plan fails an eligibility rule (costs, R:R, trend, size)
 *   WAIT_FOR_ENTRY   pending trigger not yet closed, or the ask is above the
 *                    maximum entry - never chase
 *   BUY_NOW          triggered, eligible, fresh, and buyable at or below max entry
 *
 * The ASK is what a buyer pays; the BID is what the position is worth if sold.
 */

export interface LiveQuote {
  bid: number;
  ask: number;
  atMs: number;
}

export const MAX_QUOTE_AGE_MS = 10 * 60_000;

/**
 * Candles from a scan older than this are not acted on: the hourly scan plus
 * the same 1.25 x timeframe grace the scan's own freshness check allows.
 */
export const MAX_SCAN_AGE_MS = 75 * 60_000;

/**
 * How current the latest scan is, for the pages. Its prices count from the
 * scan itself or from a later live check of the same scan (the worker's
 * monitor, every minute); its candles only from the scan. Both must be fresh
 * for any action to be shown. `staleMinutes` is the age of whichever is stale.
 */
export function scanFreshness(
  scan: { id: string; finishedAtMs: number },
  heartbeat: { scanId: string | null; checkedAtMs: number } | null,
  now: number,
): { fresh: boolean; pricesAtMs: number; staleMinutes: number } {
  const pricesAtMs = Math.max(scan.finishedAtMs, heartbeat?.scanId === scan.id ? heartbeat.checkedAtMs : 0);
  const pricesFresh = now - pricesAtMs <= MAX_QUOTE_AGE_MS;
  const candlesFresh = now - scan.finishedAtMs <= MAX_SCAN_AGE_MS;
  const staleSince = pricesFresh ? scan.finishedAtMs : pricesAtMs;
  return { fresh: pricesFresh && candlesFresh, pricesAtMs, staleMinutes: Math.round((now - staleSince) / 60_000) };
}

export function evaluateState(
  plan: TradePlan,
  quote: LiveQuote | null,
  candlesFresh: boolean,
  now: number,
): { state: SetupState; reason: StateReason } {
  if (now > plan.expiresAtMs) return { state: 'EXPIRED', reason: 'expired' };
  if (!candlesFresh || !quote || now - quote.atMs > MAX_QUOTE_AGE_MS) return { state: 'DATA_STALE', reason: 'stale_data' };
  if (plan.kind === 'pending' && plan.trigger) {
    if (quote.bid < Math.min(plan.stopLoss, plan.trigger.price - plan.atr)) {
      return { state: 'INVALIDATED', reason: 'left_trigger_zone' };
    }
  } else if (quote.bid <= plan.stopLoss) {
    return { state: 'INVALIDATED', reason: 'below_stop' };
  }
  if (quote.bid >= plan.takeProfit1) return { state: 'MISSED', reason: 'target_passed' };
  if (!plan.eligibility.ok) return { state: 'NOT_ELIGIBLE', reason: 'not_eligible' };
  if (plan.kind === 'pending') return { state: 'WAIT_FOR_ENTRY', reason: 'awaiting_trigger' };
  if (quote.ask > plan.entry.max) return { state: 'WAIT_FOR_ENTRY', reason: 'above_max_entry' };
  return { state: 'BUY_NOW', reason: 'actionable' };
}

/** Terminal states never come back; a later scan creates a new setup instead. */
export function isTerminal(state: SetupState): boolean {
  return state === 'MISSED' || state === 'INVALIDATED' || state === 'EXPIRED';
}
