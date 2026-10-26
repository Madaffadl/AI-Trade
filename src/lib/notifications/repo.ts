import 'server-only';
import { db } from '@/lib/db/driver';
import { newId, nowMs } from '@/lib/db/repo';

/**
 * Alert creation with state-transition deduplication.
 *
 * `dedupe_key` identifies the alert-worthy STATE (e.g. "signal X became
 * active"), never the refresh that observed it. A scheduled job that
 * recomputes the same unchanged signal produces the same key, the insert is
 * rejected by the unique constraint, and nothing is delivered twice.
 */

export type AlertKind =
  | 'new_signal'
  | 'signal_invalidated'
  | 'price_threshold'
  | 'news'
  | 'provider_failure'
  | 'watchlist_event';

export interface AlertRow {
  id: string;
  dedupe_key: string;
  kind: AlertKind;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  asset_id: string | null;
  signal_id: string | null;
  article_id: string | null;
  created_at_ms: number;
  read_at_ms: number | null;
  payload_json: string | null;
}

export interface NewAlert {
  dedupeKey: string;
  kind: AlertKind;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  assetId?: string | null;
  signalId?: string | null;
  articleId?: string | null;
  payload?: unknown;
}

export async function createAlertIfNew(a: NewAlert): Promise<{ created: boolean; alert: AlertRow }> {
  const d = await db();
  const existing = await d.get<AlertRow>('SELECT * FROM alerts WHERE dedupe_key = ?', [a.dedupeKey]);
  if (existing) return { created: false, alert: existing };

  const id = newId();
  await d.run(
    `INSERT INTO alerts (id, dedupe_key, kind, severity, title, body, asset_id, signal_id, article_id, created_at_ms, payload_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      a.dedupeKey,
      a.kind,
      a.severity,
      a.title,
      a.body,
      a.assetId ?? null,
      a.signalId ?? null,
      a.articleId ?? null,
      nowMs(),
      a.payload ? JSON.stringify(a.payload) : null,
    ],
  );
  const alert = await d.get<AlertRow>('SELECT * FROM alerts WHERE id = ?', [id]);
  return { created: true, alert: alert! };
}

export async function listAlerts(limit = 50, unreadOnly = false): Promise<AlertRow[]> {
  const d = await db();
  return unreadOnly
    ? d.all<AlertRow>('SELECT * FROM alerts WHERE read_at_ms IS NULL ORDER BY created_at_ms DESC LIMIT ?', [limit])
    : d.all<AlertRow>('SELECT * FROM alerts ORDER BY created_at_ms DESC LIMIT ?', [limit]);
}

export async function countUnread(): Promise<number> {
  const d = await db();
  const row = await d.get<{ n: number }>('SELECT COUNT(*) AS n FROM alerts WHERE read_at_ms IS NULL');
  return Number(row?.n ?? 0);
}

export async function markAlertRead(id: string): Promise<void> {
  const d = await db();
  await d.run('UPDATE alerts SET read_at_ms = ? WHERE id = ? AND read_at_ms IS NULL', [nowMs(), id]);
}

export async function markAllAlertsRead(): Promise<number> {
  const d = await db();
  const unread = await countUnread();
  await d.run('UPDATE alerts SET read_at_ms = ? WHERE read_at_ms IS NULL', [nowMs()]);
  return unread;
}

export async function recordDelivery(
  alertId: string,
  channel: 'in_app' | 'telegram',
  status: 'pending' | 'sent' | 'failed' | 'suppressed',
  error?: string,
): Promise<void> {
  const d = await db();
  await d.run(
    `INSERT INTO notification_deliveries (id, alert_id, channel, status, attempted_at_ms, delivered_at_ms, error)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (alert_id, channel) DO UPDATE SET
       status = excluded.status, delivered_at_ms = excluded.delivered_at_ms, error = excluded.error`,
    [newId(), alertId, channel, status, nowMs(), status === 'sent' ? nowMs() : null, error?.slice(0, 300) ?? null],
  );
}

export async function listDeliveries(limit = 50) {
  const d = await db();
  return d.all<{ alert_id: string; channel: string; status: string; attempted_at_ms: number; error: string | null; title: string }>(
    `SELECT n.alert_id, n.channel, n.status, n.attempted_at_ms, n.error, a.title
     FROM notification_deliveries n JOIN alerts a ON a.id = n.alert_id
     ORDER BY n.attempted_at_ms DESC LIMIT ?`,
    [limit],
  );
}
