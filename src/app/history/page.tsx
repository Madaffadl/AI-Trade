import Link from 'next/link';
import { listEvaluations } from '@/lib/evaluation/forward';
import { formatAge, formatNumber, formatPercentSigned, formatUtc } from '@/lib/format';
import { listSignals } from '@/lib/signals/repo';
import { ActionBadge, actionHint, Card, EmptyState, InfoNote, Stat, Table } from '@/components/ui';
import { HeadHint } from '@/components/hint';
import { getMessages } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

const OUTCOME_TONE: Record<string, string> = {
  target_hit: 'text-up',
  timeout_gain: 'text-up',
  stop_hit: 'text-down',
  timeout_loss: 'text-down',
  pending: 'text-ink-faint',
  unevaluable: 'text-ink-faint',
};

export default async function HistoryPage() {
  const t = await getMessages();
  const [signals, evaluations] = await Promise.all([listSignals({ limit: 200 }), listEvaluations(200)]);
  const byId = new Map(evaluations.map((e) => [e.signal_id, e]));

  const completed = evaluations.filter((e) => e.outcome !== 'pending' && e.outcome !== 'unevaluable');
  const pending = evaluations.filter((e) => e.outcome === 'pending').length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink">{t.history.title}</h1>
        <p className="text-2xs text-ink-muted">{t.history.subtitle}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t.history.statRecorded} value={signals.length} />
        <Stat label={t.history.statEvaluated} value={completed.length} sub={t.history.statEvaluatedSub} />
        <Stat label={t.history.statPending} value={pending} sub={t.history.statPendingSub} />
        <Stat
          label={t.history.statOverlap}
          value={evaluations.filter((e) => e.overlaps_prior === 1).length}
          sub={t.history.statOverlapSub}
        />
      </div>

      <Card title={t.history.tableTitle}>
        {signals.length === 0 ? (
          <EmptyState
            title={t.history.empty}
            body={t.history.emptyBody}
          />
        ) : (
          <Table
            head={[
              t.common.generated,
              t.signals.action,
              t.common.asset,
              'TF',
              t.common.strategy,
              t.common.version,
              <HeadHint key="e" label={t.signals.entry} text={t.glossary.entry} />,
              <HeadHint key="s" label={t.signals.stop} text={t.glossary.stopLoss} />,
              <HeadHint key="tp" label="TP1" text={t.glossary.takeProfit} />,
              t.common.status,
              <HeadHint key="o" label={t.signals.outcome} text={t.glossary.forwardEval} />,
              t.signals.netReturn,
              <HeadHint key="r" label="R" text={t.glossary.rMultiple} />,
              t.history.bars,
            ]}
          >
            {signals.map((s) => {
              const ev = byId.get(s.id);
              return (
                <tr key={s.id} className="hover:bg-bg-inset/60">
                  <td className="px-2 py-2 text-2xs text-ink-faint" title={formatUtc(s.generated_at_ms)}>
                    {formatAge(s.generated_at_ms)}
                  </td>
                  <td className="px-2 py-2">
                    <ActionBadge action={s.action} hint={actionHint(t, s.action)} />
                  </td>
                  <td className="px-2 py-2">
                    <Link href={`/assets/${s.asset_id}?tf=${s.timeframe}`} className="text-ink hover:text-accent">
                      {s.symbol}
                    </Link>
                  </td>
                  <td className="px-2 py-2 text-2xs text-ink-muted">{s.timeframe}</td>
                  <td className="px-2 py-2 text-2xs text-ink-muted">{s.strategy_id}</td>
                  <td className="px-2 py-2 text-2xs text-ink-faint">{s.strategy_version}</td>
                  <td className="num px-2 py-2 text-ink-muted">{formatNumber(s.price_at_signal, 2)}</td>
                  <td className="num px-2 py-2 text-down">{formatNumber(s.stop_loss, 2)}</td>
                  <td className="num px-2 py-2 text-up">{formatNumber(s.take_profit_1, 2)}</td>
                  <td className="px-2 py-2 text-2xs text-ink-muted">{s.status}</td>
                  <td className={`px-2 py-2 text-2xs ${OUTCOME_TONE[ev?.outcome ?? 'pending']}`}>
                    {ev ? ev.outcome.replace(/_/g, ' ') : t.history.notEvaluated}
                    {ev?.overlaps_prior === 1 && <span className="ml-1 text-ink-faint">{t.history.overlap}</span>}
                  </td>
                  <td className={`num whitespace-nowrap px-2 py-2 ${(ev?.return_pct_net ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>
                    {formatPercentSigned(ev?.return_pct_net ?? null)}
                  </td>
                  <td className="num px-2 py-2 text-ink-muted">{formatNumber(ev?.r_multiple ?? null, 2)}</td>
                  <td className="num px-2 py-2 text-ink-faint">{ev?.bars_observed ?? '—'}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <InfoNote>{t.history.footer}</InfoNote>
    </div>
  );
}
