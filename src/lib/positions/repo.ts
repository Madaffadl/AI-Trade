import 'server-only';
import { db } from '@/lib/db/driver';
import { newId, nowMs } from '@/lib/db/repo';
import type { Timeframe, TradingStyle } from '@/lib/market/types';

/**
 * Positions the user actually holds, recorded manually after buying at a real
 * venue. The app never places orders and never connects to a broker.
 */

export { VENUES, type Venue } from './types';
import type { Venue } from './types';

export interface PositionRow {
  id: string;
  asset_id: string;
  venue: string;
  side: string;
  quantity: number;
  entry_price: number;
  entry_at_ms: number;
  entry_fee: number | null;
  stop_loss: number | null;
  take_profit_1: number | null;
  take_profit_2: number | null;
  timeframe: Timeframe;
  trading_style: string;
  strategy_id: string | null;
  strategy_version: string | null;
  opened_from_signal_id: string | null;
  status: 'open' | 'closed';
  exit_price: number | null;
  exit_at_ms: number | null;
  exit_fee: number | null;
  exit_reason: string | null;
  realized_pnl: number | null;
  realized_pnl_pct: number | null;
  notes: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface PositionWithAsset extends PositionRow {
  symbol: string;
  display_name: string;
  exchange_id: string;
  currency: string;
  asset_class: string;
}

export interface NewPosition {
  assetId: string;
  venue: Venue;
  quantity: number;
  entryPrice: number;
  entryAtMs: number;
  entryFee: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  timeframe: Timeframe;
  tradingStyle: TradingStyle;
  strategyId: string | null;
  strategyVersion: string | null;
  openedFromSignalId: string | null;
  notes: string | null;
}

export async function createPosition(p: NewPosition): Promise<PositionRow> {
  const d = await db();
  const id = newId();
  const ts = nowMs();
  await d.run(
    `INSERT INTO positions (
       id, asset_id, venue, side, quantity, entry_price, entry_at_ms, entry_fee,
       stop_loss, take_profit_1, take_profit_2, timeframe, trading_style,
       strategy_id, strategy_version, opened_from_signal_id, status,
       notes, created_at_ms, updated_at_ms
     ) VALUES (?,?,?,'long',?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?)`,
    [
      id,
      p.assetId,
      p.venue,
      p.quantity,
      p.entryPrice,
      p.entryAtMs,
      p.entryFee,
      p.stopLoss,
      p.takeProfit1,
      p.takeProfit2,
      p.timeframe,
      p.tradingStyle,
      p.strategyId,
      p.strategyVersion,
      p.openedFromSignalId,
      p.notes,
      ts,
      ts,
    ],
  );
  const row = await d.get<PositionRow>('SELECT * FROM positions WHERE id = ?', [id]);
  return row!;
}

/**
 * Close a position with the price actually received.
 * Realised P&L is net of both recorded fees; an unrecorded fee is treated as
 * zero and the UI discloses that rather than inventing a cost.
 */
export async function closePosition(
  id: string,
  exitPrice: number,
  exitAtMs: number,
  exitFee: number | null,
  exitReason: string | null,
): Promise<PositionRow | null> {
  const d = await db();
  const row = await d.get<PositionRow>('SELECT * FROM positions WHERE id = ? AND status = ?', [id, 'open']);
  if (!row) return null;

  const gross = (exitPrice - row.entry_price) * row.quantity;
  const fees = (row.entry_fee ?? 0) + (exitFee ?? 0);
  const net = gross - fees;
  const cost = row.entry_price * row.quantity;
  const pct = cost > 0 ? (net / cost) * 100 : null;

  await d.run(
    `UPDATE positions SET status = 'closed', exit_price = ?, exit_at_ms = ?, exit_fee = ?,
       exit_reason = ?, realized_pnl = ?, realized_pnl_pct = ?, updated_at_ms = ? WHERE id = ?`,
    [exitPrice, exitAtMs, exitFee, exitReason, net, pct, nowMs(), id],
  );
  const updated = await d.get<PositionRow>('SELECT * FROM positions WHERE id = ?', [id]);
  return updated ?? null;
}

export async function updatePositionPlan(
  id: string,
  plan: { stopLoss: number | null; takeProfit1: number | null; takeProfit2: number | null; notes: string | null },
): Promise<void> {
  const d = await db();
  await d.run(
    `UPDATE positions SET stop_loss = ?, take_profit_1 = ?, take_profit_2 = ?, notes = ?, updated_at_ms = ?
     WHERE id = ? AND status = 'open'`,
    [plan.stopLoss, plan.takeProfit1, plan.takeProfit2, plan.notes, nowMs(), id],
  );
}

export async function deletePosition(id: string): Promise<void> {
  const d = await db();
  await d.run('DELETE FROM positions WHERE id = ?', [id]);
}

const SELECT_WITH_ASSET = `
  SELECT p.*, a.symbol, a.display_name, a.exchange_id, a.currency, a.asset_class
  FROM positions p JOIN assets a ON a.id = p.asset_id`;

export async function listPositions(status?: 'open' | 'closed'): Promise<PositionWithAsset[]> {
  const d = await db();
  return status
    ? d.all<PositionWithAsset>(`${SELECT_WITH_ASSET} WHERE p.status = ? ORDER BY p.entry_at_ms DESC`, [status])
    : d.all<PositionWithAsset>(`${SELECT_WITH_ASSET} ORDER BY p.entry_at_ms DESC`);
}

export async function getPosition(id: string): Promise<PositionWithAsset | null> {
  const d = await db();
  const row = await d.get<PositionWithAsset>(`${SELECT_WITH_ASSET} WHERE p.id = ?`, [id]);
  return row ?? null;
}

/** The open position for an asset, if any. Used by the signal engine. */
export async function findOpenPositionForAsset(assetId: string): Promise<PositionRow | null> {
  const d = await db();
  const row = await d.get<PositionRow>(
    `SELECT * FROM positions WHERE asset_id = ? AND status = 'open' ORDER BY entry_at_ms DESC LIMIT 1`,
    [assetId],
  );
  return row ?? null;
}

export async function countOpenPositions(): Promise<number> {
  const d = await db();
  const row = await d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM positions WHERE status = 'open'`);
  return Number(row?.n ?? 0);
}
