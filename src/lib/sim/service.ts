import 'server-only';
import { getAssetById, loadCandles } from '@/lib/db/repo';
import { computeMetrics, type TradeRecord } from '@/lib/evaluation/metrics';
import type { IndodaxTicker } from '@/lib/indodax/api';
import { startOfWibDay } from '@/lib/plan/engine';
import { latestTriggeredSetup, type StoredSetup } from '@/lib/plan/repo';
import { floorToStep, sizePosition } from '@/lib/plan/sizing';
import type { TradePlan } from '@/lib/plan/types';
import { getTradingSettings, type TradingSettings } from '@/lib/settings/trading';
import {
  checkExits,
  fillEntry,
  fillExit,
  realizedPnlPercent,
  replayCandles,
  simCosts,
  simEvents,
  tryEntry,
  unrealizedPnl,
  type Quote,
  type SimEvent,
  type SimState,
} from './fills';
import { insertSimTrade, listSimTrades, saveSimState, setupSimulated, stateOf, type SimTrade } from './repo';

/**
 * Paper trading: a virtual account that follows plans with the same rules a
 * real trade would face (see fills.ts for the fill assumptions).
 *
 * The account starts from the configured virtual capital; its equity is that
 * plus every realised result. Positions are sized exactly like a real plan -
 * risk %, per-position cap, free cash, quantity step, Rp10,000 minimum - but
 * from the SIMULATED equity and cash, so the simulation answers "what would
 * following these plans have done to this much money".
 */

const ACTIVE: SimTrade['status'][] = ['pending_entry', 'open'];

export interface SimAccount {
  startCapitalIdr: number;
  realizedIdr: number;
  unrealizedIdr: number;
  equityIdr: number;
  /** Capital tied up in open simulated positions (at their entry price). */
  committedIdr: number;
  cashIdr: number;
  openCount: number;
  pendingCount: number;
  dailyLossPercent: number;
}

export async function simAccount(trades?: SimTrade[], settings?: TradingSettings, now = Date.now()): Promise<SimAccount> {
  const all = trades ?? (await listSimTrades());
  const s = settings ?? (await getTradingSettings());
  const realized = all.reduce((a, t) => a + t.realized_pnl_idr, 0);
  const open = all.filter((t) => t.status === 'open');
  const committed = open.reduce((a, t) => a + (t.quantity ?? 0) * (t.entry_price ?? 0), 0);
  const unrealized = open.reduce((a, t) => a + (t.mark_price === null ? 0 : (unrealizedPnl(stateOf(t), t.mark_price, t.costs) ?? 0)), 0);
  const dayStart = startOfWibDay(now);
  const lostToday = all
    .flatMap((t) => t.fills)
    .filter((f) => f.side === 'sell' && f.atMs >= dayStart)
    .reduce((a, f) => a + (f.pnlIdr ?? 0), 0);
  const equity = s.simStartCapitalIdr + realized;
  return {
    startCapitalIdr: s.simStartCapitalIdr,
    realizedIdr: realized,
    unrealizedIdr: unrealized,
    equityIdr: equity,
    committedIdr: committed,
    cashIdr: Math.max(0, equity - committed),
    openCount: open.length,
    pendingCount: all.filter((t) => t.status === 'pending_entry').length,
    dailyLossPercent: lostToday < 0 && equity > 0 ? (-lostToday / s.simStartCapitalIdr) * 100 : 0,
  };
}

/** Quantity for a simulated entry at `price`, sized from the simulated account. */
async function sizer(plan: TradePlan, settings: TradingSettings, account: SimAccount) {
  const asset = await getAssetById(plan.assetId);
  const costs = simCosts(plan.costs);
  return (price: number): number => {
    const r = sizePosition({
      entry: price,
      stop: plan.stopLoss,
      usableCapitalIdr: account.equityIdr,
      cashAvailableIdr: account.cashIdr,
      riskPercent: settings.riskPercent,
      maxAllocationPercent: settings.maxAllocationPercent,
      quantityIncrement: asset?.lotSize ?? null,
      minOrderIdr: asset?.minNotional ?? 10_000,
      costs,
    });
    return r.ok ? r.quantity : 0;
  };
}

export type StartOutcome =
  | { ok: true; trade: SimTrade; filled: boolean }
  | { ok: false; reason: 'not_actionable' | 'already_simulating' | 'max_positions' | 'too_small' | 'daily_stop' };

/**
 * Start simulating a setup. BUY NOW fills immediately at the ask (if still at
 * or below the maximum entry); otherwise the order rests: at the maximum entry
 * for a price that ran ahead, or until the strategy confirms a pending trigger.
 */
export async function startSimulation(setup: StoredSetup, mode: 'auto' | 'manual', quote: Quote | null): Promise<StartOutcome> {
  if (setup.state !== 'BUY_NOW' && setup.state !== 'WAIT_FOR_ENTRY') return { ok: false, reason: 'not_actionable' };
  const settings = await getTradingSettings();
  const trades = await listSimTrades();
  const account = await simAccount(trades, settings);
  if (trades.some((t) => ACTIVE.includes(t.status) && t.asset_id === setup.asset_id)) return { ok: false, reason: 'already_simulating' };
  if (account.openCount + account.pendingCount >= settings.maxOpenPositions) return { ok: false, reason: 'max_positions' };
  if (account.dailyLossPercent >= settings.maxDailyLossPercent) return { ok: false, reason: 'daily_stop' };

  const plan = setup.plan;
  const costs = simCosts(plan.costs);
  const size = await sizer(plan, settings, account);
  if (!(size(plan.entry.max) > 0)) return { ok: false, reason: 'too_small' };

  const entryKind = plan.kind === 'pending' ? 'trigger' : 'limit';
  let state: SimState = {
    status: 'pending_entry',
    entryKind,
    entryMax: plan.entry.max,
    stopLoss: plan.stopLoss,
    takeProfit1: plan.takeProfit1,
    horizonMs: plan.holding.horizonMs,
    expiresAtMs: plan.expiresAtMs,
    initialQuantity: null,
    quantity: null,
    entryPrice: null,
    entryAtMs: null,
    sellByMs: null,
    realizedPnlIdr: 0,
    exitPrice: null,
    exitAtMs: null,
    exitReason: null,
    fills: [],
  };
  const now = Date.now();
  if (entryKind === 'limit' && quote) state = tryEntry(state, quote, now, size, costs);
  const filled = state.status === 'open';
  const trade = await insertSimTrade({
    mode,
    setupId: setup.id,
    plan,
    entryKind: filled ? 'market' : entryKind,
    costs,
    state,
  });
  return { ok: true, trade, filled };
}

export interface SimTradeEvent {
  trade: SimTrade;
  event: SimEvent;
}

/**
 * Advance every active simulation against the live tickers: pending entries
 * fill or expire, open trades replay the candles they missed and then check
 * stop, target and sell-by time. Returns how many trades changed and what
 * happened to them (fills, expiries), for the alerts.
 */
export async function monitorSimulations(
  tickers: ReadonlyMap<string, IndodaxTicker>,
  now = Date.now(),
): Promise<{ changed: number; events: SimTradeEvent[] }> {
  const settings = await getTradingSettings();
  const trades = await listSimTrades(ACTIVE);
  let changed = 0;
  const events: SimTradeEvent[] = [];
  for (const t of trades) {
    const tk = tickers.get(t.symbol);
    const quote: Quote | null = tk ? { bid: tk.bid, ask: tk.ask, atMs: tk.serverTimeMs ?? now } : null;
    const initial = stateOf(t);
    let state = initial;
    const before = JSON.stringify(state);
    const extra: Parameters<typeof saveSimState>[2] = { checkedAtMs: now };

    if (state.status === 'pending_entry') {
      if (state.entryKind === 'trigger') {
        const confirmed = await latestTriggeredSetup(t.asset_id, t.strategy_id, t.timeframe, t.created_at_ms);
        if (now > state.expiresAtMs) {
          state = { ...state, status: 'cancelled', exitReason: 'expired', exitAtMs: now };
        } else if (confirmed && confirmed.state === 'BUY_NOW' && quote && quote.ask <= confirmed.plan.entry.max) {
          // Trade the levels the strategy produced on the confirming candle.
          const p = confirmed.plan;
          const account = await simAccount(undefined, settings, now);
          const qty = (await sizer(p, settings, account))(quote.ask);
          if (qty > 0) {
            state = { ...state, entryMax: p.entry.max, stopLoss: p.stopLoss, takeProfit1: p.takeProfit1, horizonMs: p.holding.horizonMs };
            state = fillEntry(state, quote.ask, qty, quote.atMs, 'ticker', t.costs);
            extra.takeProfit2 = p.takeProfit2;
          }
        }
      } else if (quote) {
        const account = await simAccount(undefined, settings, now);
        state = tryEntry(state, quote, now, await sizer(t.plan, settings, account), t.costs);
      } else if (now > state.expiresAtMs) {
        state = { ...state, status: 'cancelled', exitReason: 'expired', exitAtMs: now };
      }
    }

    if (state.status === 'open') {
      const from = t.last_checked_ms ?? state.entryAtMs ?? now;
      const candles = (await loadCandles(t.asset_id, '1h', 300)).candles;
      state = replayCandles(state, candles, from, t.costs);
      if (quote) {
        state = checkExits(state, quote, now, t.costs);
        extra.markPrice = quote.bid;
        extra.markAtMs = quote.atMs;
      }
    }

    if (JSON.stringify(state) !== before) changed++;
    await saveSimState(t.id, state, extra);
    for (const event of simEvents(initial, state)) events.push({ trade: t, event });
  }
  return { changed, events };
}

/** Open simulations for the BUY NOW setups of a scan, best first, within the account's limits. Returns the trades opened. */
export async function autoSimulate(ranked: readonly StoredSetup[], tickers: ReadonlyMap<string, IndodaxTicker>): Promise<SimTrade[]> {
  const settings = await getTradingSettings();
  if (!settings.autoSimulate) return [];
  const opened: SimTrade[] = [];
  for (const setup of ranked) {
    if (setup.state !== 'BUY_NOW') continue;
    if (await setupSimulated(setup.id)) continue;
    const tk = tickers.get(setup.plan.symbol);
    const r = await startSimulation(setup, 'auto', tk ? { bid: tk.bid, ask: tk.ask, atMs: tk.serverTimeMs ?? Date.now() } : null);
    if (r.ok) opened.push(r.trade);
    else if (r.reason === 'max_positions' || r.reason === 'daily_stop') break;
  }
  return opened;
}

/** Close all or part of an open simulation at the live bid, or cancel a pending one. */
export async function closeSimulation(trade: SimTrade, quote: Quote | null, fraction = 1): Promise<SimState> {
  let state = stateOf(trade);
  if (state.status === 'pending_entry') {
    state = { ...state, status: 'cancelled', exitReason: 'cancelled', exitAtMs: Date.now() };
  } else if (state.status === 'open' && quote) {
    const asset = await getAssetById(trade.asset_id);
    const all = state.quantity ?? 0;
    const qty = fraction >= 1 ? all : floorToStep(all * fraction, asset?.lotSize ?? null);
    state = fillExit(state, quote.bid, quote.atMs, 'manual', 'manual', trade.costs, qty);
  }
  await saveSimState(trade.id, state, quote ? { markPrice: quote.bid, markAtMs: quote.atMs, checkedAtMs: Date.now() } : {});
  return state;
}

/** Closed-trade statistics in the same terms the strategy evaluation uses. */
export function simMetrics(trades: readonly SimTrade[]) {
  const closed = trades.filter((t) => t.status === 'closed' && t.entry_price !== null);
  const records: TradeRecord[] = closed.map((t) => {
    const pct = realizedPnlPercent(stateOf(t), t.costs) ?? 0;
    const risk = t.initial_quantity && t.entry_price ? t.initial_quantity * (t.entry_price - t.stop_loss) : 0;
    return {
      returnPctNet: pct,
      rMultiple: risk > 0 ? t.realized_pnl_idr / risk : 0,
      outcome: t.exit_reason === 'tp1' ? 'target_hit' : t.exit_reason === 'stop' ? 'stop_hit' : pct >= 0 ? 'timeout_gain' : 'timeout_loss',
      generatedAtMs: t.entry_at_ms ?? t.created_at_ms,
      overlapsPrior: false,
    };
  });
  return computeMetrics(records);
}
