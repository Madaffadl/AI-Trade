import Link from 'next/link';
import { Card, EmptyState, InfoNote, Table, WarningNote } from '@/components/ui';
import { actionLine, failureText, pairLabel, StateBadge, strategyLabel, timeframeLabel } from '@/components/plan/plan-view';
import { RefreshScanButton } from '@/components/plan/refresh-button';
import { nowMs } from '@/lib/db/repo';
import { formatIdr, formatWib } from '@/lib/format';
import { getMessages } from '@/lib/i18n';
import { rankSetups } from '@/lib/plan/ranking';
import { latestScanRun, listSetupsForScan, type StoredSetup } from '@/lib/plan/repo';
import { monitorHeartbeat } from '@/lib/jobs/monitor';
import { scanFreshness } from '@/lib/plan/states';

export const dynamic = 'force-dynamic';

/** Every setup of the latest scan - actionable first, then the rejected ones with the reason. */
export default async function OpportunitiesPage() {
  const t = await getMessages();
  const now = nowMs();
  const scan = await latestScanRun();
  const setups = scan ? await listSetupsForScan(scan.id) : [];
  const actionable = rankSetups(setups);
  const rest = setups
    .filter((s) => !actionable.includes(s))
    .sort((a, b) => b.score - a.score || a.plan.symbol.localeCompare(b.plan.symbol));
  const rows: StoredSetup[] = [...actionable, ...rest];
  const freshness = scan
    ? scanFreshness({ id: scan.id, finishedAtMs: scan.finished_at_ms ?? scan.started_at_ms }, await monitorHeartbeat(), now)
    : null;
  const withoutSetup = scan?.summary?.pairs.filter((p) => p.status !== 'setup') ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t.nav.opportunities}</h1>
          <p className="mt-0.5 text-2xs text-ink-muted">{t.plan.oppSubtitle}</p>
          {scan && (
            <p className="mt-0.5 text-2xs text-ink-faint">
              {t.plan.dataStatus(formatWib(scan.finished_at_ms ?? scan.started_at_ms), scan.universe_size)}
            </p>
          )}
        </div>
        <RefreshScanButton labels={{ refresh: t.plan.refresh, refreshing: t.plan.refreshing, failed: t.plan.refreshFailed }} />
      </div>

      {freshness && !freshness.fresh && <WarningNote>{t.plan.staleBody(freshness.staleMinutes)}</WarningNote>}

      <Card title={t.nav.opportunities}>
        {rows.length === 0 ? (
          <EmptyState title={scan ? t.plan.noSetups : t.plan.neverScanned} body={scan ? t.plan.decisionNoTradeBody : t.plan.neverScannedBody} />
        ) : (
          <Table
            caption={t.nav.opportunities}
            head={[t.plan.colState, t.plan.colPair, t.plan.colTimeframe, t.plan.colStrategy, t.plan.colEntry, t.plan.stopLoss, t.plan.target1, t.plan.riskReward, t.plan.colScore, t.plan.colReason]}
          >
            {rows.map((s) => {
              const why =
                s.state === 'NOT_ELIGIBLE'
                  ? s.plan.eligibility.failures.map((f) => failureText(t, s.plan, f)).join('; ')
                  : (actionLine(t, s.plan, s.state, s.state_reason) ?? '');
              return (
                <tr key={s.id}>
                  <td className="px-2 py-2"><StateBadge state={s.state} t={t} /></td>
                  <td className="px-2 py-2 text-xs">
                    <Link href={`/opportunities/${s.id}`} className="font-medium text-ink hover:text-accent">
                      {pairLabel(s.plan)}
                    </Link>
                  </td>
                  <td className="px-2 py-2 text-2xs text-ink-muted">{timeframeLabel(t, s.plan.timeframe)}</td>
                  <td className="px-2 py-2 text-2xs text-ink-muted">{strategyLabel(t, s.plan.strategyId)}</td>
                  <td className="num px-2 py-2 text-xs">
                    {formatIdr(s.plan.entry.planned)} <span className="text-ink-faint">({formatIdr(s.plan.entry.max)})</span>
                  </td>
                  <td className="num px-2 py-2 text-xs text-down">{formatIdr(s.plan.stopLoss)}</td>
                  <td className="num px-2 py-2 text-xs text-up">{formatIdr(s.plan.takeProfit1)}</td>
                  <td className="num px-2 py-2 text-xs">1 : {s.plan.outcome.netRiskReward.toFixed(2)}</td>
                  <td className="num px-2 py-2 text-xs">{s.score.toFixed(2)}</td>
                  <td className="max-w-[22rem] px-2 py-2 text-2xs text-ink-muted">{why}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <InfoNote>{t.plan.scoreNote}</InfoNote>

      {withoutSetup.length > 0 && (
        <Card title={t.plan.pairsTitle} subtitle={t.plan.pairsBody}>
          <ul className="space-y-1.5">
            {withoutSetup.map((p) => (
              <li key={`${p.symbol}-${p.timeframe}`} className="text-2xs">
                <span className="font-medium text-ink">{p.symbol}</span>{' '}
                <span className="text-ink-faint">{timeframeLabel(t, p.timeframe)}</span>{' '}
                <span className="text-ink-muted">— {p.detail}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
