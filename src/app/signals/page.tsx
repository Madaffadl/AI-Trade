import Link from 'next/link';
import { listSignals } from '@/lib/signals/repo';
import { SIGNAL_ACTIONS } from '@/lib/market/types';
import { ActionBadge, Card, EmptyState, InfoNote, StrengthBadge, Table } from '@/components/ui';
import { HeadHint } from '@/components/hint';
import { actionHint } from '@/components/scan-table';
import { formatAge, formatNumber, formatPrice, formatUtc } from '@/lib/format';
import { getMessages } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

export default async function SignalsPage({ searchParams }: { searchParams: Promise<{ action?: string; status?: string }> }) {
  const t = await getMessages();
  const params = await searchParams;
  const action = (SIGNAL_ACTIONS as readonly string[]).includes(params.action ?? '') ? params.action : undefined;
  const status = ['active', 'invalidated', 'expired', 'closed'].includes(params.status ?? '') ? params.status : undefined;

  const signals = await listSignals({
    action: action as (typeof SIGNAL_ACTIONS)[number] | undefined,
    status,
    limit: 100,
  });

  const chip = (href: string, label: string, active: boolean) => (
    <Link
      key={label}
      href={href}
      className={`rounded px-2 py-1 text-2xs ${active ? 'bg-accent-dim text-accent' : 'text-ink-muted hover:bg-bg-inset hover:text-ink'}`}
    >
      {label}
    </Link>
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink">{t.signals.title}</h1>
        <p className="text-2xs text-ink-muted">{t.signals.subtitle}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded border border-line bg-bg-raised px-3 py-2.5">
        <span className="text-2xs uppercase tracking-wide text-ink-faint">{t.signals.action}</span>
        <div className="flex gap-1">
          {chip('/signals', t.common.all, !action)}
          {chip('/signals?action=BUY', 'BUY', action === 'BUY')}
          {chip('/signals?action=SELL', 'SELL', action === 'SELL')}
        </div>
        <span className="ml-3 text-2xs uppercase tracking-wide text-ink-faint">{t.signals.statusLabel}</span>
        <div className="flex gap-1">
          {chip('/signals', t.signals.any, !status)}
          {chip('/signals?status=active', t.signals.active, status === 'active')}
          {chip('/signals?status=invalidated', t.signals.invalidated, status === 'invalidated')}
          {chip('/signals?status=expired', t.signals.expired, status === 'expired')}
        </div>
      </div>

      <Card title={t.signals.feed(signals.length)}>
        {signals.length === 0 ? (
          <EmptyState
            title={t.signals.empty}
            body={t.signals.emptyBody}
          />
        ) : (
          <Table
            head={[
              t.signals.action,
              t.common.asset,
              t.signals.tfStyle,
              t.common.strategy,
              t.common.price,
              <HeadHint key="entry" label={t.signals.entry} text={t.glossary.entry} />,
              <HeadHint key="stop" label={t.signals.stop} text={t.glossary.stopLoss} />,
              <HeadHint key="tp" label="TP1" text={t.glossary.takeProfit} />,
              <HeadHint key="rr" label="R:R" text={t.glossary.riskReward} />,
              <HeadHint key="setup" label={t.signals.setup} text={t.glossary.setupStrength} />,
              t.common.regime,
              t.common.status,
              t.common.generated,
            ]}
          >
            {signals.map((s) => (
              <tr key={s.id} className="hover:bg-bg-inset/60">
                <td className="px-2 py-2">
                  <ActionBadge action={s.action} hint={actionHint(t, s.action)} />
                </td>
                <td className="px-2 py-2">
                  <Link href={`/signals/${s.id}`} className="font-medium text-ink hover:text-accent">
                    {s.symbol}
                  </Link>
                  <span className="ml-1 text-2xs text-ink-faint">{s.exchange_id}</span>
                </td>
                <td className="px-2 py-2 text-2xs text-ink-muted">
                  {s.timeframe} · {s.trading_style}
                </td>
                <td className="px-2 py-2 text-2xs text-ink-muted">
                  {s.strategy_id}
                  <span className="text-ink-faint">@{s.strategy_version}</span>
                </td>
                <td className="num px-2 py-2 text-ink">{formatPrice(s.price_at_signal, s.currency)}</td>
                <td className="num px-2 py-2 text-ink-muted">{formatPrice(s.entry_low)}</td>
                <td className="num px-2 py-2 text-down">{formatPrice(s.stop_loss)}</td>
                <td className="num px-2 py-2 text-up">{formatPrice(s.take_profit_1)}</td>
                <td className="num px-2 py-2 text-ink-muted">{formatNumber(s.risk_reward, 2)}</td>
                <td className="px-2 py-2">
                  <StrengthBadge strength={s.strength} labels={t.strength} />
                </td>
                <td className="px-2 py-2 text-2xs text-ink-muted">{s.regime.replace(/_/g, ' ')}</td>
                <td className="px-2 py-2 text-2xs text-ink-muted">{s.status}</td>
                <td className="px-2 py-2 text-2xs text-ink-faint" title={formatUtc(s.generated_at_ms)}>
                  {formatAge(s.generated_at_ms)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <InfoNote>
        <strong>{t.signals.labelsTitle}</strong> {t.signals.labelsBody}
      </InfoNote>
    </div>
  );
}
