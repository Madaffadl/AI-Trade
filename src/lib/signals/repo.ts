import 'server-only';
import { createHash } from 'node:crypto';
import { db } from '@/lib/db/driver';
import { newId, nowMs } from '@/lib/db/repo';
import type { SetupStrength, SignalAction, Timeframe } from '@/lib/market/types';

/**
 * Signal persistence.
 *
 * The central idea is `signal_key`: a deterministic fingerprint of a SETUP
 * rather than of an evaluation event. Re-running the engine on unchanged data
 * recomputes the same key, the insert is a no-op, and no duplicate alert is
 * produced. This is what stops a scheduled job from alerting every refresh.
 */

export interface SignalRecord {
  id: string;
  signal_key: string;
  asset_id: string;
  timeframe: Timeframe;
  trading_style: string;
  strategy_id: string;
  strategy_version: string;
  action: SignalAction;
  strength: SetupStrength;
  generated_at_ms: number;
  candle_open_ms: number;
  data_fetched_ms: number;
  price_at_signal: number;
  entry_low: number | null;
  entry_high: number | null;
  stop_loss: number | null;
  take_profit_1: number | null;
  take_profit_2: number | null;
  risk_reward: number | null;
  position_size: number | null;
  risk_amount: number | null;
  regime: string;
  data_quality: string;
  reasons_json: string;
  risks_json: string;
  invalidation_json: string;
  indicators_json: string;
  news_ids_json: string | null;
  analysis_run_id: string | null;
  status: string;
  closed_at_ms: number | null;
}

export interface SignalWithAsset extends SignalRecord {
  symbol: string;
  display_name: string;
  exchange_id: string;
  asset_class: string;
  currency: string;
}

/**
 * Deterministic setup fingerprint.
 *
 * Includes the trigger BAR, not the generation time, so re-evaluating the same
 * bar yields the same key. A new bar that still satisfies the rules is a
 * genuinely new setup and does produce a new signal.
 */
export function computeSignalKey(parts: {
  strategyId: string;
  strategyVersion: string;
  assetId: string;
  timeframe: string;
  action: SignalAction;
  candleOpenMs: number;
}): string {
  const canonical = [
    parts.strategyId,
    parts.strategyVersion,
    parts.assetId,
    parts.timeframe,
    parts.action,
    String(parts.candleOpenMs),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export interface NewSignal {
  signalKey: string;
  assetId: string;
  timeframe: Timeframe;
  tradingStyle: string;
  strategyId: string;
  strategyVersion: string;
  action: SignalAction;
  strength: SetupStrength;
  candleOpenMs: number;
  dataFetchedMs: number;
  priceAtSignal: number;
  entryLow: number | null;
  entryHigh: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  riskReward: number | null;
  positionSize: number | null;
  riskAmount: number | null;
  regime: string;
  dataQuality: string;
  reasons: unknown;
  risks: unknown;
  invalidation: unknown;
  indicators: unknown;
  newsIds: string[] | null;
}

/**
 * Insert a signal if its key is new.
 * Returns the row plus whether this call created it - only a creation is
 * alert-worthy.
 */
export async function insertSignalIfNew(s: NewSignal): Promise<{ created: boolean; signal: SignalRecord }> {
  const d = await db();
  const existing = await d.get<SignalRecord>('SELECT * FROM trading_signals WHERE signal_key = ?', [s.signalKey]);
  if (existing) return { created: false, signal: existing };

  const id = newId();
  await d.run(
    `INSERT INTO trading_signals (
       id, signal_key, asset_id, timeframe, trading_style, strategy_id, strategy_version,
       action, strength, generated_at_ms, candle_open_ms, data_fetched_ms, price_at_signal,
       entry_low, entry_high, stop_loss, take_profit_1, take_profit_2, risk_reward,
       position_size, risk_amount, regime, data_quality,
       reasons_json, risks_json, invalidation_json, indicators_json, news_ids_json, status
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active')`,
    [
      id,
      s.signalKey,
      s.assetId,
      s.timeframe,
      s.tradingStyle,
      s.strategyId,
      s.strategyVersion,
      s.action,
      s.strength,
      nowMs(),
      s.candleOpenMs,
      s.dataFetchedMs,
      s.priceAtSignal,
      s.entryLow,
      s.entryHigh,
      s.stopLoss,
      s.takeProfit1,
      s.takeProfit2,
      s.riskReward,
      s.positionSize,
      s.riskAmount,
      s.regime,
      s.dataQuality,
      JSON.stringify(s.reasons),
      JSON.stringify(s.risks),
      JSON.stringify(s.invalidation),
      JSON.stringify(s.indicators),
      s.newsIds ? JSON.stringify(s.newsIds) : null,
    ],
  );
  const signal = await d.get<SignalRecord>('SELECT * FROM trading_signals WHERE id = ?', [id]);
  return { created: true, signal: signal! };
}

/** The most recent still-open BUY for an asset+strategy ("existing holding"). */
export async function findOpenPosition(
  assetId: string,
  strategyId: string,
  timeframe: Timeframe,
): Promise<SignalRecord | null> {
  const d = await db();
  const row = await d.get<SignalRecord>(
    `SELECT * FROM trading_signals
     WHERE asset_id = ? AND strategy_id = ? AND timeframe = ? AND action = 'BUY' AND status = 'active'
     ORDER BY generated_at_ms DESC LIMIT 1`,
    [assetId, strategyId, timeframe],
  );
  return row ?? null;
}

export async function updateSignalStatus(
  id: string,
  status: 'active' | 'invalidated' | 'expired' | 'closed',
): Promise<void> {
  const d = await db();
  await d.run('UPDATE trading_signals SET status = ?, closed_at_ms = ? WHERE id = ?', [
    status,
    status === 'active' ? null : nowMs(),
    id,
  ]);
}

export interface SignalFilter {
  action?: SignalAction;
  assetId?: string;
  status?: string;
  strategyId?: string;
  limit?: number;
}

export async function listSignals(filter: SignalFilter = {}): Promise<SignalWithAsset[]> {
  const d = await db();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.action) {
    where.push('s.action = ?');
    params.push(filter.action);
  }
  if (filter.assetId) {
    where.push('s.asset_id = ?');
    params.push(filter.assetId);
  }
  if (filter.status) {
    where.push('s.status = ?');
    params.push(filter.status);
  }
  if (filter.strategyId) {
    where.push('s.strategy_id = ?');
    params.push(filter.strategyId);
  }
  params.push(filter.limit ?? 100);
  return d.all<SignalWithAsset>(
    `SELECT s.*, a.symbol, a.display_name, a.exchange_id, a.asset_class, a.currency
     FROM trading_signals s JOIN assets a ON a.id = s.asset_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY s.generated_at_ms DESC LIMIT ?`,
    params,
  );
}

export async function getSignal(id: string): Promise<SignalWithAsset | null> {
  const d = await db();
  const row = await d.get<SignalWithAsset>(
    `SELECT s.*, a.symbol, a.display_name, a.exchange_id, a.asset_class, a.currency
     FROM trading_signals s JOIN assets a ON a.id = s.asset_id WHERE s.id = ?`,
    [id],
  );
  return row ?? null;
}

/** Active actionable signals (BUY/SELL) used for invalidation checks. */
export async function listActiveActionable(): Promise<SignalWithAsset[]> {
  const d = await db();
  return d.all<SignalWithAsset>(
    `SELECT s.*, a.symbol, a.display_name, a.exchange_id, a.asset_class, a.currency
     FROM trading_signals s JOIN assets a ON a.id = s.asset_id
     WHERE s.status = 'active' AND s.action IN ('BUY','SELL')
     ORDER BY s.generated_at_ms DESC`,
  );
}

export async function upsertStrategyDefinition(def: {
  id: string;
  version: string;
  name: string;
  description: string;
  assetClasses: string[];
  timeframes: string[];
  parameters: Record<string, number>;
  warmupBars: number;
}): Promise<void> {
  const d = await db();
  await d.run(
    `INSERT INTO strategy_definitions (id, version, name, description, asset_classes, timeframes, parameters_json, warmup_bars, enabled, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,1,?)
     ON CONFLICT (id, version) DO UPDATE SET
       name = excluded.name, description = excluded.description,
       asset_classes = excluded.asset_classes, timeframes = excluded.timeframes,
       parameters_json = excluded.parameters_json, warmup_bars = excluded.warmup_bars`,
    [
      def.id,
      def.version,
      def.name,
      def.description,
      JSON.stringify(def.assetClasses),
      JSON.stringify(def.timeframes),
      JSON.stringify(def.parameters),
      def.warmupBars,
      nowMs(),
    ],
  );
}
