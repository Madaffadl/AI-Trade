import type { Candle } from '@/lib/market/types';
import { entryCostPercent, exitCostPercent, type CostModel } from '@/lib/plan/costs';

/**
 * Paper-trading fill rules. Pure: every function takes a trade state and
 * returns the next one, so the rules are unit-tested exactly as they run.
 *
 * Fill assumptions (shown to the user and stored on every trade):
 *   ENTRY   market: the live ASK at that moment, only if it is at or below the
 *           plan's maximum entry. limit: rests at the maximum entry and fills
 *           at the ask once the ask comes down to it. trigger: fills only after
 *           the strategy has confirmed the trigger on a CLOSED candle, then at
 *           the live ask - never at a historical price that was not available.
 *   STOP    the live BID once it is at or below the stop (a stop executes as a
 *           market sell, so a gap fills BELOW the stop, never at it).
 *   TARGET  exactly at target 1 (a resting limit sell).
 *   TIME    the live BID once the sell-by time has passed.
 *   GAPS    while nobody was watching, closed 1h candles are replayed: a stop
 *           and a target inside the same candle count as the STOP; a candle
 *           that opens through the stop fills at its open.
 * Costs: the trading fee, sale tax and levies of the plan's cost model. The
 * spread is NOT charged again - filling at the real bid/ask already pays it.
 */

export type SimStatus = 'pending_entry' | 'open' | 'closed' | 'cancelled';
export type EntryKind = 'market' | 'limit' | 'trigger';
export type ExitReason = 'stop' | 'tp1' | 'time' | 'manual' | 'expired' | 'cancelled';

export interface Fill {
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  atMs: number;
  source: 'ticker' | 'candle' | 'manual';
  reason: string;
  costIdr: number;
  /** For sells: net result of this sale, after its share of entry costs. */
  pnlIdr?: number;
}

export interface SimState {
  status: SimStatus;
  entryKind: EntryKind;
  entryMax: number;
  stopLoss: number;
  takeProfit1: number;
  horizonMs: number;
  expiresAtMs: number;
  initialQuantity: number | null;
  quantity: number | null;
  entryPrice: number | null;
  entryAtMs: number | null;
  sellByMs: number | null;
  realizedPnlIdr: number;
  exitPrice: number | null;
  exitAtMs: number | null;
  exitReason: ExitReason | null;
  fills: Fill[];
}

export interface Quote {
  bid: number;
  ask: number;
  atMs: number;
}

/** The plan's cost model without the spread component (fills already pay the spread). */
export function simCosts(planCosts: CostModel): CostModel {
  return { ...planCosts, halfSpreadPercent: 0 };
}

/** Open the position at `price`. `quantity` comes from sizing at that price. */
export function fillEntry(s: SimState, price: number, quantity: number, atMs: number, source: Fill['source'], costs: CostModel): SimState {
  const costIdr = (quantity * price * entryCostPercent(costs)) / 100;
  return {
    ...s,
    status: 'open',
    entryPrice: price,
    entryAtMs: atMs,
    initialQuantity: quantity,
    quantity,
    sellByMs: atMs + s.horizonMs,
    fills: [...s.fills, { side: 'buy', quantity, price, atMs, source, reason: s.entryKind, costIdr }],
  };
}

/** Sell `quantity` (all that is open by default) at `price`. */
export function fillExit(
  s: SimState,
  price: number,
  atMs: number,
  reason: ExitReason,
  source: Fill['source'],
  costs: CostModel,
  quantity: number = s.quantity ?? 0,
): SimState {
  if (s.status !== 'open' || s.entryPrice === null || !s.quantity || quantity <= 0) return s;
  const qty = Math.min(quantity, s.quantity);
  const entryShare = (qty * s.entryPrice * entryCostPercent(costs)) / 100;
  const exitCost = (qty * price * exitCostPercent(costs)) / 100;
  const pnlIdr = qty * (price - s.entryPrice) - entryShare - exitCost;
  const remaining = Number((s.quantity - qty).toPrecision(12));
  const closed = remaining <= 0;
  const sold = [...s.fills.filter((f) => f.side === 'sell'), { quantity: qty, price }];
  const avgExit = sold.reduce((a, f) => a + f.quantity * f.price, 0) / sold.reduce((a, f) => a + f.quantity, 0);
  return {
    ...s,
    status: closed ? 'closed' : 'open',
    quantity: closed ? 0 : remaining,
    realizedPnlIdr: s.realizedPnlIdr + pnlIdr,
    exitPrice: closed ? avgExit : s.exitPrice,
    exitAtMs: closed ? atMs : s.exitAtMs,
    exitReason: closed ? reason : s.exitReason,
    fills: [...s.fills, { side: 'sell', quantity: qty, price, atMs, source, reason, costIdr: exitCost, pnlIdr }],
  };
}

/**
 * A pending market/limit entry against the live quote: fills at the ask once
 * the ask is at or below the maximum entry; cancelled once the setup expires.
 * Trigger entries are filled by the caller when the strategy confirms them.
 */
export function tryEntry(
  s: SimState,
  q: Quote,
  now: number,
  size: (price: number) => number,
  costs: CostModel,
): SimState {
  if (s.status !== 'pending_entry') return s;
  if (now > s.expiresAtMs) return { ...s, status: 'cancelled', exitReason: 'expired', exitAtMs: now };
  if (s.entryKind === 'trigger') return s;
  if (q.ask > s.entryMax) return s;
  const quantity = size(q.ask);
  if (!(quantity > 0)) return s;
  return fillEntry(s, q.ask, quantity, q.atMs, 'ticker', costs);
}

/** An open trade against the live quote: stop, then target, then sell-by time. */
export function checkExits(s: SimState, q: Quote, now: number, costs: CostModel): SimState {
  if (s.status !== 'open') return s;
  if (q.bid <= s.stopLoss) return fillExit(s, q.bid, q.atMs, 'stop', 'ticker', costs);
  if (q.bid >= s.takeProfit1) return fillExit(s, s.takeProfit1, q.atMs, 'tp1', 'ticker', costs);
  if (s.sellByMs !== null && now >= s.sellByMs) return fillExit(s, q.bid, q.atMs, 'time', 'ticker', costs);
  return s;
}

/**
 * Replay closed candles that started at or after `fromMs` (the last time the
 * trade was checked), for the hours when no live check ran. The candle in
 * progress at the last check is skipped: whether its low came before or after
 * that check is unknowable, and the live check covers the present.
 */
export function replayCandles(s: SimState, candles: readonly Candle[], fromMs: number, costs: CostModel): SimState {
  const state = s;
  if (state.status !== 'open') return state;
  for (const c of candles) {
    if (c.isPartial || c.openTimeMs < fromMs) continue;
    if (state.sellByMs !== null && c.openTimeMs >= state.sellByMs) {
      return fillExit(state, c.open, c.openTimeMs, 'time', 'candle', costs);
    }
    const hitStop = c.low <= state.stopLoss;
    const hitTarget = c.high >= state.takeProfit1;
    if (hitStop) {
      // Opened through the stop: the stop order fills at the open, not the stop.
      const price = c.open < state.stopLoss ? c.open : state.stopLoss;
      return fillExit(state, price, c.openTimeMs, 'stop', 'candle', costs);
    }
    if (hitTarget) return fillExit(state, state.takeProfit1, c.openTimeMs, 'tp1', 'candle', costs);
  }
  return state;
}

export type SimEvent =
  | { kind: 'fill'; index: number; fill: Fill }
  | { kind: 'expired' };

/**
 * What happened between two states of the same trade: every new fill, and an
 * order that expired without filling. `before` is null for a trade that did
 * not exist yet (an auto-simulation that filled on creation).
 */
export function simEvents(before: SimState | null, after: SimState): SimEvent[] {
  const from = before?.fills.length ?? 0;
  const events: SimEvent[] = after.fills.slice(from).map((fill, i) => ({ kind: 'fill', index: from + i, fill }));
  if (after.status === 'cancelled' && after.exitReason === 'expired' && before?.status !== 'cancelled') {
    events.push({ kind: 'expired' });
  }
  return events;
}

/** Result of the open quantity if sold at `mark`, after all costs. */
export function unrealizedPnl(s: SimState, mark: number, costs: CostModel): number | null {
  if (s.status !== 'open' || s.entryPrice === null || !s.quantity) return null;
  const q = s.quantity;
  return q * (mark - s.entryPrice) - (q * s.entryPrice * entryCostPercent(costs)) / 100 - (q * mark * exitCostPercent(costs)) / 100;
}

/** Realised result as % of what the entry cost (price x quantity + entry costs). */
export function realizedPnlPercent(s: SimState, costs: CostModel): number | null {
  if (s.entryPrice === null || !s.initialQuantity) return null;
  const outlay = s.initialQuantity * s.entryPrice * (1 + entryCostPercent(costs) / 100);
  return (s.realizedPnlIdr / outlay) * 100;
}
