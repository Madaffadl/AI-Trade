import 'server-only';
import { db } from '@/lib/db/driver';
import { newId, nowMs } from '@/lib/db/repo';
import type { ScoreBreakdown } from './ranking';
import type { SetupState, StateReason, TradePlan, ValidationLabel } from './types';

/** Persistence for scans and trade setups. All SQL for the plan engine lives here. */

export type ScanDecision = 'BUY_NOW' | 'WAIT_FOR_ENTRY' | 'NO_TRADE' | 'DATA_UNAVAILABLE' | 'DAILY_STOP' | 'POSITIONS_FULL';

export interface PairScanStatus {
  symbol: string;
  timeframe: string;
  /** 'setup' when a setup was produced, otherwise why not. */
  status: 'setup' | 'no_setup' | 'data_unavailable';
  detail: string;
  /** Market regime on the entry timeframe; null when there was no usable data. */
  regime: string | null;
  /** Whether the higher-timeframe trend was up; null when there was no usable data. */
  contextUp: boolean | null;
}

export interface ScanSummary {
  pairs: PairScanStatus[];
  stateCounts: Partial<Record<SetupState, number>>;
  usableCapitalIdr: number;
  cashAvailableIdr: number;
  openPositions: number;
  maxOpenPositions: number;
  dailyLossPercent: number;
  maxDailyLossPercent: number;
  universeGeneratedAtMs: number | null;
  durationMs: number;
}

export interface ScanRunRow {
  id: string;
  started_at_ms: number;
  finished_at_ms: number | null;
  engine_version: string;
  status: string;
  decision: ScanDecision;
  top_setup_id: string | null;
  universe_size: number;
  pairs_with_data: number;
  summary_json: string;
  error: string | null;
}

export interface SetupRow {
  id: string;
  setup_key: string;
  asset_id: string;
  strategy_id: string;
  strategy_version: string;
  engine_version: string;
  timeframe: string;
  context_timeframe: string;
  kind: string;
  state: SetupState;
  state_reason: StateReason;
  candle_open_ms: number;
  trigger_price: number | null;
  entry_planned: number;
  entry_max: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number | null;
  score: number;
  validation: ValidationLabel;
  plan_json: string;
  score_json: string | null;
  signal_id: string | null;
  analysis_run_id: string | null;
  last_scan_id: string | null;
  expires_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
  state_changed_at_ms: number;
}

export interface StoredSetup extends SetupRow {
  plan: TradePlan;
  scoreBreakdown: ScoreBreakdown | null;
}

export function hydrate(row: SetupRow): StoredSetup {
  return {
    ...row,
    plan: JSON.parse(row.plan_json) as TradePlan,
    scoreBreakdown: row.score_json ? (JSON.parse(row.score_json) as ScoreBreakdown) : null,
  };
}

export function setupKey(plan: Pick<TradePlan, 'strategyId' | 'strategyVersion' | 'assetId' | 'timeframe' | 'kind' | 'signalBarOpenMs'>): string {
  return [plan.strategyId, plan.strategyVersion, plan.assetId, plan.timeframe, plan.kind, plan.signalBarOpenMs].join('|');
}

export async function startScanRun(engineVersion: string): Promise<string> {
  const id = newId();
  const d = await db();
  await d.run(
    `INSERT INTO scan_runs (id, started_at_ms, engine_version, status, decision, summary_json)
     VALUES (?, ?, ?, 'running', 'DATA_UNAVAILABLE', '{}')`,
    [id, nowMs(), engineVersion],
  );
  return id;
}

export async function finishScanRun(
  id: string,
  r: {
    status: 'ok' | 'partial' | 'error';
    decision: ScanDecision;
    topSetupId: string | null;
    universeSize: number;
    pairsWithData: number;
    summary: ScanSummary | Record<string, never>;
    error?: string | null;
  },
): Promise<void> {
  const d = await db();
  await d.run(
    `UPDATE scan_runs SET finished_at_ms = ?, status = ?, decision = ?, top_setup_id = ?, universe_size = ?,
       pairs_with_data = ?, summary_json = ?, error = ? WHERE id = ?`,
    [nowMs(), r.status, r.decision, r.topSetupId, r.universeSize, r.pairsWithData, JSON.stringify(r.summary), r.error ?? null, id],
  );
}

/** The live monitor's re-evaluation of a finished scan: same scan, fresher decision. */
export async function updateScanDecision(id: string, decision: ScanDecision, topSetupId: string | null): Promise<void> {
  const d = await db();
  await d.run('UPDATE scan_runs SET decision = ?, top_setup_id = ? WHERE id = ?', [decision, topSetupId, id]);
}

/** Link a setup to the AI commentary generated for it. */
export async function setSetupAnalysis(id: string, analysisRunId: string): Promise<void> {
  const d = await db();
  await d.run('UPDATE trade_setups SET analysis_run_id = ? WHERE id = ?', [analysisRunId, id]);
}

/**
 * Newest successful AI run already linked to an equivalent setup - same pair,
 * strategy, timeframe and kind - generated since `sinceMs`. A pending setup is
 * re-created on every new candle; this lets it reuse the explanation written
 * an hour ago instead of spending another AI call on the same situation.
 */
export async function reusableAnalysisRun(
  s: Pick<SetupRow, 'asset_id' | 'strategy_id' | 'timeframe' | 'kind'>,
  sinceMs: number,
): Promise<string | null> {
  const d = await db();
  const row = await d.get<{ id: string }>(
    `SELECT r.id FROM trade_setups s JOIN analysis_runs r ON r.id = s.analysis_run_id
      WHERE s.asset_id = ? AND s.strategy_id = ? AND s.timeframe = ? AND s.kind = ?
        AND r.ai_status = 'ok' AND r.started_at_ms >= ?
      ORDER BY r.started_at_ms DESC LIMIT 1`,
    [s.asset_id, s.strategy_id, s.timeframe, s.kind, sinceMs],
  );
  return row?.id ?? null;
}

export async function latestScanRun(): Promise<(ScanRunRow & { summary: ScanSummary | null }) | null> {
  const d = await db();
  const row = await d.get<ScanRunRow>(
    `SELECT * FROM scan_runs WHERE status <> 'running' ORDER BY started_at_ms DESC LIMIT 1`,
  );
  if (!row) return null;
  let summary: ScanSummary | null = null;
  try {
    const parsed = JSON.parse(row.summary_json) as ScanSummary;
    summary = Array.isArray(parsed.pairs) ? parsed : null;
  } catch {
    summary = null;
  }
  return { ...row, summary };
}

export async function getSetupByKey(key: string): Promise<StoredSetup | null> {
  const d = await db();
  const row = await d.get<SetupRow>('SELECT * FROM trade_setups WHERE setup_key = ?', [key]);
  return row ? hydrate(row) : null;
}

export async function getSetup(id: string): Promise<StoredSetup | null> {
  const d = await db();
  const row = await d.get<SetupRow>('SELECT * FROM trade_setups WHERE id = ?', [id]);
  return row ? hydrate(row) : null;
}

/** Insert or refresh a setup. `state_changed_at_ms` only moves when the state actually changes. */
export async function upsertSetup(s: {
  plan: TradePlan;
  state: SetupState;
  reason: StateReason;
  score: ScoreBreakdown | null;
  validation: ValidationLabel;
  scanId: string;
  signalId: string | null;
}): Promise<StoredSetup> {
  const d = await db();
  const key = setupKey(s.plan);
  const now = nowMs();
  const p = s.plan;
  await d.run(
    `INSERT INTO trade_setups
       (id, setup_key, asset_id, strategy_id, strategy_version, engine_version, timeframe, context_timeframe, kind,
        state, state_reason, candle_open_ms, trigger_price, entry_planned, entry_max, stop_loss, take_profit_1,
        take_profit_2, score, validation, plan_json, score_json, signal_id, last_scan_id, expires_at_ms,
        created_at_ms, updated_at_ms, state_changed_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (setup_key) DO UPDATE SET
       state_changed_at_ms = CASE WHEN trade_setups.state <> excluded.state THEN excluded.updated_at_ms
                                  ELSE trade_setups.state_changed_at_ms END,
       state = excluded.state,
       state_reason = excluded.state_reason,
       entry_planned = excluded.entry_planned,
       entry_max = excluded.entry_max,
       score = excluded.score,
       validation = excluded.validation,
       plan_json = excluded.plan_json,
       score_json = excluded.score_json,
       signal_id = COALESCE(trade_setups.signal_id, excluded.signal_id),
       last_scan_id = excluded.last_scan_id,
       updated_at_ms = excluded.updated_at_ms`,
    [
      newId(), key, p.assetId, p.strategyId, p.strategyVersion, p.engineVersion, p.timeframe, p.contextTimeframe, p.kind,
      s.state, s.reason, p.signalBarOpenMs, p.trigger?.price ?? null, p.entry.planned, p.entry.max, p.stopLoss,
      p.takeProfit1, p.takeProfit2, s.score?.score ?? 0, s.validation, JSON.stringify(p),
      s.score ? JSON.stringify(s.score) : null, s.signalId, s.scanId, p.expiresAtMs, now, now, now,
    ],
  );
  return (await getSetupByKey(key))!;
}

export async function updateSetupState(id: string, state: SetupState, reason: StateReason, scanId: string | null): Promise<void> {
  const d = await db();
  const now = nowMs();
  await d.run(
    `UPDATE trade_setups SET
       state_changed_at_ms = CASE WHEN state <> ? THEN ? ELSE state_changed_at_ms END,
       state = ?, state_reason = ?, updated_at_ms = ?, last_scan_id = COALESCE(?, last_scan_id)
     WHERE id = ?`,
    [state, now, state, reason, now, scanId, id],
  );
}

/** Setups that are not in a terminal state. */
export async function listLiveSetups(): Promise<StoredSetup[]> {
  const d = await db();
  const rows = await d.all<SetupRow>(
    `SELECT * FROM trade_setups WHERE state NOT IN ('MISSED','INVALIDATED','EXPIRED') ORDER BY score DESC`,
  );
  return rows.map(hydrate);
}

export async function listSetupsForScan(scanId: string): Promise<StoredSetup[]> {
  const d = await db();
  const rows = await d.all<SetupRow>('SELECT * FROM trade_setups WHERE last_scan_id = ? ORDER BY score DESC', [scanId]);
  return rows.map(hydrate);
}

/**
 * The newest triggered setup for a strategy x pair x timeframe produced since
 * `sinceMs` - how a pending (wait-for-trigger) simulation learns that its
 * trigger was confirmed on a closed candle.
 */
export async function latestTriggeredSetup(
  assetId: string,
  strategyId: string,
  timeframe: string,
  sinceMs: number,
): Promise<StoredSetup | null> {
  const d = await db();
  const row = await d.get<SetupRow>(
    `SELECT * FROM trade_setups
      WHERE asset_id = ? AND strategy_id = ? AND timeframe = ? AND kind = 'triggered' AND created_at_ms >= ?
      ORDER BY created_at_ms DESC LIMIT 1`,
    [assetId, strategyId, timeframe, sinceMs],
  );
  return row ? hydrate(row) : null;
}
