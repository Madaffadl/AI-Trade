import { features } from '@/lib/config/env';
import { formatAge, formatUtc } from '@/lib/format';
import { listAlerts, listDeliveries } from '@/lib/notifications/repo';
import { Card, EmptyState, InfoNote, Stat } from '@/components/ui';
import { MarkReadButtons } from './mark-read';
import { getMessages } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

const SEVERITY_TONE: Record<string, string> = {
  info: 'border-accent/30 bg-accent-dim text-accent',
  warning: 'border-warn/30 bg-warn-dim text-warn',
  critical: 'border-down/30 bg-down-dim text-down',
};

export default async function AlertsPage() {
  const t = await getMessages();
  const flags = features();
  const [alerts, deliveries] = await Promise.all([listAlerts(100), listDeliveries(60)]);
  const unread = alerts.filter((a) => a.read_at_ms === null).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t.alerts.title}</h1>
          <p className="text-2xs text-ink-muted">
            {t.alerts.subtitle(flags.telegramEnabled ? t.alerts.telegramOn : t.alerts.telegramOff)}
          </p>
        </div>
        <MarkReadButtons unread={unread} label={t.alerts.markAllRead} busyLabel={t.alerts.marking} />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t.alerts.statTotal} value={alerts.length} />
        <Stat label={t.alerts.statUnread} value={unread} />
        <Stat
          label={t.alerts.statTelegram}
          value={flags.telegramEnabled ? t.settings.telegramOn : t.settings.telegramOff}
          sub={t.alerts.statTelegramSub}
        />
        <Stat label={t.alerts.statDeliveries} value={deliveries.length} />
      </div>

      <Card title={t.alerts.feedTitle} subtitle={t.alerts.feedSub}>
        {alerts.length === 0 ? (
          <EmptyState title={t.alerts.empty} body={t.alerts.emptyBody} />
        ) : (
          <ul className="space-y-2">
            {alerts.map((a) => (
              <li
                key={a.id}
                className={`rounded border px-3 py-2 ${a.read_at_ms === null ? 'border-line-strong bg-bg-inset' : 'border-line bg-bg-raised'}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded border px-1.5 py-px text-2xs font-medium ${SEVERITY_TONE[a.severity]}`}>
                    {a.severity}
                  </span>
                  <span className="text-xs font-medium text-ink">{a.title}</span>
                  <span className="text-2xs text-ink-faint">{a.kind}</span>
                  <span className="ml-auto text-2xs text-ink-faint" title={formatUtc(a.created_at_ms)}>
                    {formatAge(a.created_at_ms)}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-2xs text-ink-muted">{a.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t.alerts.deliveryTitle}>
        {deliveries.length === 0 ? (
          <EmptyState title={t.alerts.noDeliveries} body={t.alerts.noDeliveriesBody} />
        ) : (
          <ul className="space-y-1">
            {deliveries.map((d, i) => (
              <li key={`${d.alert_id}-${d.channel}-${i}`} className="flex flex-wrap items-center gap-2 text-2xs">
                <span className="rounded border border-line-strong px-1 py-px text-ink-muted">{d.channel}</span>
                <span className={d.status === 'sent' ? 'text-up' : d.status === 'failed' ? 'text-down' : 'text-ink-faint'}>
                  {d.status}
                </span>
                <span className="truncate text-ink-muted">{d.title}</span>
                {d.error && <span className="text-down">{d.error}</span>}
                <span className="ml-auto text-ink-faint">{formatAge(d.attempted_at_ms)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <InfoNote>{t.alerts.footer}</InfoNote>
    </div>
  );
}
