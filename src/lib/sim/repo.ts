import 'server-only';
import { db } from '@/lib/db/driver';
import { newId, nowMs } from '@/lib/db/repo';
import type { CostModel } from '@/lib/plan/costs';
import type { TradePlan } from '@/lib/plan/types';
import type { EntryKind, ExitReason, Fill, SimState, SimStatus } from './fills';

/** Persistence for paper trades. */

export interface SimTradeRow {
  id: string;
  mode: 'auto' | 'manual';
  setup_id: string | null;
  asset_id: string;
  symbol: string;
  strategy_id: string;
  strategy_version: string;
  timeframe: string;
  entry_kind: EntryKind;
  status: SimStatus;
  trigger_price: number | null;
  entry_max: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number | null;
  horizon_ms: number;
  expires_at_ms: number;
  initial_quantity: number | null;
  quantity: number | null;
  entry_price: number | null;
  entry_at_ms: number | null;
  sell_by_ms: number | null;
  realized_pnl_idr: number;
  exit_price: number | null;
  exit_at_ms: number | null;
  exit_reason: ExitReason | null;
  mark_price: number | null;
  mark_at_ms: number | null;
  last_checked_ms: number | null;
  plan_json: string;
  costs_json: string;
  fills_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface SimTrade extends SimTradeRow {
  plan: TradePlan;
  costs: CostModel;
  fills: Fill[];
}

export function hydrate(row: SimTradeRow): SimTrade {
  return {
    ...row,
    plan: JSON.parse(row.plan_json) as TradePlan,
    costs: JSON.parse(row.costs_json) as CostModel,
    fills: JSON.parse(row.fills_json) as Fill[],
  };
}

export function stateOf(t: SimTrade): SimState {
  return {
    status: t.status,
    entryKind: t.entry_kind,
    entryMax: t.entry_max,
    stopLoss: t.stop_loss,
    takeProfit1: t.take_profit_1,
    horizonMs: t.horizon_ms,
    expiresAtMs: t.expires_at_ms,
    initialQuantity: t.initial_quantity,
    quantity: t.quantity,
    entryPrice: t.entry_price,
    entryAtMs: t.entry_at_ms,
    sellByMs: t.sell_by_ms,
    realizedPnlIdr: t.realized_pnl_idr,
    exitPrice: t.exit_price,
    exitAtMs: t.exit_at_ms,
    exitReason: t.exit_reason,
    fills: t.fills,
  };
}

export async function insertSimTrade(t: {
  mode: 'auto' | 'manual';
  setupId: string | null;
  plan: TradePlan;
  entryKind: EntryKind;
  costs: CostModel;
  state: SimState;
}): Promise<SimTrade> {
  const d = await db();
  const id = newId();
  const now = nowMs();
  const s = t.state;
  await d.run(
    `INSERT INTO sim_trades
       (id, mode, setup_id, asset_id, symbol, strategy_id, strategy_version, timeframe, entry_kind, status,
        trigger_price, entry_max, stop_loss, take_profit_1, take_profit_2, horizon_ms, expires_at_ms,
        initial_quantity, quantity, entry_price, entry_at_ms, sell_by_ms, realized_pnl_idr,
        exit_price, exit_at_ms, exit_reason, mark_price, mark_at_ms, last_checked_ms,
        plan_json, costs_json, fills_json, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, t.mode, t.setupId, t.plan.assetId, t.plan.symbol, t.plan.strategyId, t.plan.strategyVersion, t.plan.timeframe,
      t.entryKind, s.status, t.plan.trigger?.price ?? null, s.entryMax, s.stopLoss, s.takeProfit1, t.plan.takeProfit2,
      s.horizonMs, s.expiresAtMs, s.initialQuantity, s.quantity, s.entryPrice, s.entryAtMs, s.sellByMs, s.realizedPnlIdr,
      s.exitPrice, s.exitAtMs, s.exitReason, s.entryPrice, s.entryAtMs, now,
      JSON.stringify(t.plan), JSON.stringify(t.costs), JSON.stringify(s.fills), now, now,
    ],
  );
  return (await getSimTrade(id))!;
}

/** Persist a new state (and, optionally, a new mark price or replaced levels). */
export async function saveSimState(
  id: string,
  s: SimState,
  extra: { markPrice?: number; markAtMs?: number; checkedAtMs?: number; takeProfit2?: number | null; entryKind?: EntryKind } = {},
): Promise<void> {
  const d = await db();
  await d.run(
    `UPDATE sim_trades SET
       status = ?, entry_kind = COALESCE(?, entry_kind), entry_max = ?, stop_loss = ?, take_profit_1 = ?,
       take_profit_2 = CASE WHEN ? = 1 THEN ? ELSE take_profit_2 END,
       initial_quantity = ?, quantity = ?, entry_price = ?, entry_at_ms = ?, sell_by_ms = ?, realized_pnl_idr = ?,
       exit_price = ?, exit_at_ms = ?, exit_reason = ?,
       mark_price = COALESCE(?, mark_price), mark_at_ms = COALESCE(?, mark_at_ms),
       last_checked_ms = COALESCE(?, last_checked_ms), fills_json = ?, updated_at_ms = ?
     WHERE id = ?`,
    [
      s.status, extra.entryKind ?? null, s.entryMax, s.stopLoss, s.takeProfit1,
      extra.takeProfit2 !== undefined ? 1 : 0, extra.takeProfit2 ?? null,
      s.initialQuantity, s.quantity, s.entryPrice, s.entryAtMs, s.sellByMs, s.realizedPnlIdr,
      s.exitPrice, s.exitAtMs, s.exitReason,
      extra.markPrice ?? null, extra.markAtMs ?? null, extra.checkedAtMs ?? null, JSON.stringify(s.fills), nowMs(), id,
    ],
  );
}

export async function getSimTrade(id: string): Promise<SimTrade | null> {
  const d = await db();
  const row = await d.get<SimTradeRow>('SELECT * FROM sim_trades WHERE id = ?', [id]);
  return row ? hydrate(row) : null;
}

export async function listSimTrades(statuses?: readonly SimStatus[]): Promise<SimTrade[]> {
  const d = await db();
  const rows = statuses
    ? await d.all<SimTradeRow>(
        `SELECT * FROM sim_trades WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at_ms DESC`,
        [...statuses],
      )
    : await d.all<SimTradeRow>('SELECT * FROM sim_trades ORDER BY created_at_ms DESC');
  return rows.map(hydrate);
}

/** Whether a setup has already been simulated (in any mode). */
export async function setupSimulated(setupId: string): Promise<boolean> {
  const d = await db();
  const row = await d.get<{ n: number }>('SELECT COUNT(*) AS n FROM sim_trades WHERE setup_id = ?', [setupId]);
  return Number(row?.n ?? 0) > 0;
}
