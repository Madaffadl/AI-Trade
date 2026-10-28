import Link from 'next/link';
import { Card, EmptyState, InfoNote, WarningNote } from '@/components/ui';
import { strategyLabel, timeframeLabel } from '@/components/plan/plan-view';
import { RefreshScanButton } from '@/components/plan/refresh-button';
import { forwardMetricsByStrategyTimeframe } from '@/lib/evaluation/forward';
import type { PerformanceMetrics } from '@/lib/evaluation/metrics';
import { VALIDATION_RULES } from '@/lib/evaluation/plan-backtest';
import { latestValidations, type StrategyValidation } from '@/lib/evaluation/validate';
import { formatDateWib, formatPercentSigned, formatWib } from '@/lib/format';
import { getMessages, type Messages } from '@/lib/i18n';
import { ENTRY_PLANS, PLAN_STRATEGY_IDS } from '@/lib/plan/types';
import { STRATEGIES } from '@/lib/strategies';
import { listSimTrades } from '@/lib/sim/repo';
import { simMetrics } from '@/lib/sim/service';

export const dynamic = 'force-dynamic';

/**
 * Performance: has each strategy x timeframe earned trust? Backtest (in- and
 * out-of-sample), benchmarks, live signals and the simulation are shown side
 * by side and never mixed.
 */
export default async function PerformancePage() {
  const t = await getMessages();
  const [validations, forward, closedSims] = await Promise.all([
    latestValidations(),
    forwardMetricsByStrategyTimeframe(),
    listSimTrades(['closed']),
  ]);
  const combos = ENTRY_PLANS.flatMap(({ timeframe }) =>
    PLAN_STRATEGY_IDS.filter((id) => STRATEGIES.find((s) => s.id === id)?.timeframes.includes(timeframe)).map((strategyId) => ({
      strategyId,
      timeframe,
    })),
  );
  const lastRun = Math.max(0, ...[...validations.values()].map((v) => v.computed_at_ms));
  const validatedCount = [...validations.values()].filter((v) => v.label === 'validated').length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t.perf.title}</h1>
          <p className="mt-0.5 text-2xs text-ink-muted">{t.perf.subtitle}</p>
          <p className="mt-0.5 text-2xs text-ink-faint">{lastRun ? t.perf.lastRun(formatWib(lastRun)) : t.perf.neverRun}</p>
        </div>
        <RefreshScanButton endpoint="/api/validate" labels={{ refresh: t.perf.run, refreshing: t.perf.running, failed: t.perf.runFailed }} />
      </div>

      <Card title={t.perf.gateTitle}>
        <p className="text-2xs leading-relaxed text-ink-muted">{t.perf.gateBody(VALIDATION_RULES.minTrades, VALIDATION_RULES.minProfitFactor)}</p>
      </Card>

      {validations.size > 0 &&
        (validatedCount === 0 ? (
          <WarningNote>{t.perf.noneValidated}</WarningNote>
        ) : (
          <InfoNote>{t.perf.validatedCount(validatedCount, combos.length)}</InfoNote>
        ))}

      {validations.size === 0 ? (
        <EmptyState title={t.perf.title} body={t.perf.neverRun} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {combos.map(({ strategyId, timeframe }) => {
            const key = `${strategyId}|${timeframe}`;
            return (
              <ComboCard
                key={key}
                t={t}
                strategyId={strategyId}
                timeframe={timeframe}
                v={validations.get(key) ?? null}
                forward={forward.get(key) ?? null}
                paper={simMetrics(closedSims.filter((s) => s.strategy_id === strategyId && s.timeframe === timeframe))}
              />
            );
          })}
        </div>
      )}

      <InfoNote>
        {t.perf.descriptive}{' '}
        <Link href="/history" className="text-accent hover:underline">
          {t.perf.historyLink}
        </Link>
      </InfoNote>
    </div>
  );
}

function ComboCard({
  t,
  strategyId,
  timeframe,
  v,
  forward,
  paper,
}: {
  t: Messages;
  strategyId: string;
  timeframe: string;
  v: StrategyValidation | null;
  forward: PerformanceMetrics | null;
  paper: PerformanceMetrics;
}) {
  const validated = v?.label === 'validated';
  const unmetText: Record<string, string> = {
    too_few_trades: t.perf.unmetTooFew(VALIDATION_RULES.minTrades),
    not_profitable: t.perf.unmetNotProfitable,
    weak_profit_factor: t.perf.unmetWeakPf(VALIDATION_RULES.minProfitFactor),
    no_better_than_random: t.perf.unmetRandom,
  };
  const rejText: Record<string, string> = {
    context_down: t.perf.rejContext,
    rr_too_low: t.perf.rejRr,
    target_within_costs: t.perf.rejCosts,
  };
  return (
    <Card
      title={`${strategyLabel(t, strategyId)} · ${timeframeLabel(t, timeframe)}`}
      actions={
        <span
          className={`rounded border px-1.5 py-0.5 text-2xs font-bold ${
            validated ? 'border-up/40 bg-up-dim text-up' : 'border-warn/40 bg-warn-dim text-warn'
          }`}
        >
          {validated ? t.plan.validated : t.plan.experimental}
        </span>
      }
    >
      {!v ? (
        <p className="text-2xs text-ink-faint">{t.perf.neverRun}</p>
      ) : (
        <div className="space-y-3 text-2xs">
          <p className="text-ink-faint">
            {t.perf.period(formatDateWib(v.period_from_ms), formatDateWib(v.period_to_ms), formatDateWib(v.split_at_ms))} · {t.perf.pairs(v.pairs)}
          </p>
          <p className="text-ink-muted">{t.perf.signalsLine(v.signals, v.inSample.trades + v.outOfSample.trades)}</p>
          {Object.keys(v.rejected).length > 0 && (
            <p className="text-ink-muted">
              {t.perf.rejectedBecause}:{' '}
              {Object.entries(v.rejected)
                .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                .map(([k, n]) => `${rejText[k] ?? k} (${n})`)
                .join(' · ')}
            </p>
          )}
          <dl className="divide-y divide-line rounded border border-line bg-bg-inset">
            <Row label={t.perf.rowInSample} m={v.inSample} t={t} />
            <Row label={t.perf.rowOutOfSample} m={v.outOfSample} t={t} strong />
            <SimpleRow label={t.perf.rowRandom} value={v.random_expectancy_pct} sub={t.perf.trades(v.random_trades)} />
            <SimpleRow label={t.perf.rowBuyHold} value={v.buy_hold_pct} />
            {forward && <Row label={t.perf.rowForward} m={forward} t={t} />}
            <Row label={t.perf.rowPaper} m={paper} t={t} />
          </dl>
          {v.unmet.length > 0 && (
            <p className="text-warn">
              {t.perf.whyExperimental}: {v.unmet.map((u) => unmetText[u] ?? u).join('; ')}.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function Row({ label, m, t, strong = false }: { label: string; m: PerformanceMetrics; t: Messages; strong?: boolean }) {
  const exp = m.expectancyPct;
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
      <dt className={strong ? 'font-semibold text-ink' : 'text-ink-muted'}>{label}</dt>
      <dd className="num text-ink-muted">
        {t.perf.trades(m.trades)}
        {m.trades > 0 && (
          <>
            {' '}· {t.perf.win} {m.winRatePct?.toFixed(0) ?? '—'}% · {t.perf.perTrade}{' '}
            <span className={exp === null ? '' : exp >= 0 ? 'text-up' : 'text-down'}>{formatPercentSigned(exp)}</span> · PF{' '}
            {m.profitFactor === null ? '—' : m.profitFactor.toFixed(2)}
          </>
        )}
      </dd>
    </div>
  );
}

function SimpleRow({ label, value, sub }: { label: string; value: number | null; sub?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="num text-ink-muted">
        {sub ? `${sub} · ` : ''}
        <span className={value === null ? '' : value >= 0 ? 'text-up' : 'text-down'}>{formatPercentSigned(value)}</span>
      </dd>
    </div>
  );
}
