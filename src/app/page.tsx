import Link from 'next/link';
import { Card, WarningNote } from '@/components/ui';
import {
  actionLine,
  failureText,
  pairLabel,
  PlanFacts,
  StateBadge,
  strategyLabel,
  timeframeLabel,
  ValidationNote,
  WhySection,
} from '@/components/plan/plan-view';
import { RefreshScanButton } from '@/components/plan/refresh-button';
import { SimulateButton } from '@/components/plan/simulate-button';
import { simulateLabels } from '@/lib/i18n/client-labels';
import { analysisForSetup } from '@/lib/analysis/service';
import { monitorHeartbeat } from '@/lib/jobs/monitor';
import { nowMs } from '@/lib/db/repo';
import { formatIdr, formatWib } from '@/lib/format';
import { getMessages, type Messages } from '@/lib/i18n';
import { rankSetups } from '@/lib/plan/ranking';
import { latestScanRun, listSetupsForScan, type ScanSummary, type StoredSetup } from '@/lib/plan/repo';
import { scanFreshness } from '@/lib/plan/states';
import { listPositions } from '@/lib/positions/repo';
import { latestValidations } from '@/lib/evaluation/validate';
import { getTradingSettings, usableCapital } from '@/lib/settings/trading';

export const dynamic = 'force-dynamic';

/**
 * Home: the decision screen.
 *
 * Answers, in this order: what to do now, which pair, at what price, where to
 * exit, how much, and how long to hold - or says plainly that there is no
 * trade. Everything shown comes from the latest stored scan, re-checked every
 * minute against live prices by the worker's monitor; rendering this page
 * never calls the exchange. Prices checked more than 10 minutes ago, or
 * candles from a scan more than 75 minutes old, show no action at all: a
 * stale BUY is worse than no BUY.
 */
export default async function HomePage() {
  const t = await getMessages();
  // Request time: this page is dynamic and renders once per request.
  const now = nowMs();
  const [scan, settings, positions, validations, heartbeat] = await Promise.all([
    latestScanRun(),
    getTradingSettings(),
    listPositions('open'),
    latestValidations(),
    monitorHeartbeat(),
  ]);
  const validatedCount = [...validations.values()].filter((v) => v.label === 'validated').length;
  const setups = scan ? await listSetupsForScan(scan.id) : [];
  const ranked = rankSetups(setups);
  const rejected = setups.filter((s) => s.state === 'NOT_ELIGIBLE');
  const freshness = scan ? scanFreshness({ id: scan.id, finishedAtMs: scan.finished_at_ms ?? scan.started_at_ms }, heartbeat, now) : null;
  const fresh = freshness?.fresh ?? false;
  // A scan skips that minute's live check, so allow a few minutes before calling the worker stopped.
  const monitorRunning = heartbeat?.monitorAtMs != null && now - heartbeat.monitorAtMs <= 5 * 60_000;
  const top = ranked[0] ?? null;
  const topAi = fresh && top?.analysis_run_id ? await analysisForSetup(top) : null;
  const indodaxPositions = positions.filter((p) => p.exchange_id === 'INDODAX');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-2xs uppercase tracking-wide text-ink-faint">{t.plan.title}</p>
          <p className="mt-0.5 text-2xs text-ink-muted">{t.plan.subtitle}</p>
          {scan && (
            <p className="mt-0.5 text-2xs text-ink-faint">
              {t.plan.dataStatus(formatWib(scan.finished_at_ms ?? scan.started_at_ms), scan.universe_size)}
            </p>
          )}
          <p className={`mt-0.5 text-2xs ${monitorRunning ? 'text-ink-faint' : 'text-warn'}`}>
            {monitorRunning ? t.plan.monitorOn(formatWib(heartbeat!.monitorAtMs)) : t.plan.monitorOff}
          </p>
        </div>
        <RefreshScanButton labels={{ refresh: t.plan.refresh, refreshing: t.plan.refreshing, failed: t.plan.refreshFailed }} />
      </div>

      {!scan ? (
        <Hero tone="neutral" title={t.plan.neverScanned} body={t.plan.neverScannedBody} />
      ) : !fresh ? (
        <Hero
          tone="warn"
          title={t.plan.staleTitle}
          body={t.plan.staleBody(freshness?.staleMinutes ?? 0)}
        />
      ) : (
        <Decision t={t} decision={scan.decision} top={top} topAi={topAi} summary={scan.summary} rejected={rejected} now={now} />
      )}

      <p className="text-2xs text-ink-muted">
        {t.plan.capitalLine(formatIdr(usableCapital(settings)), formatIdr(scan?.summary?.cashAvailableIdr ?? usableCapital(settings)), settings.riskPercent)}{' '}
        ·{' '}
        <Link href="/settings#trading" className="text-accent hover:underline">
          {t.plan.settingsLink}
        </Link>
      </p>

      {fresh && ranked.length > 1 && (
        <Card title={t.plan.othersTitle}>
          <ul className="space-y-2">
            {ranked.slice(1, 4).map((s) => (
              <SetupRow key={s.id} s={s} t={t} />
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title={t.plan.positionsTitle}
          actions={
            <Link href="/portfolio" className="inline-flex min-h-[24px] items-center text-2xs text-accent hover:underline">
              {t.plan.managePositions}
            </Link>
          }
        >
          <p className="text-xs text-ink-muted">
            {indodaxPositions.length > 0 ? t.plan.positionsBody(indodaxPositions.length) : t.plan.positionsEmpty}
          </p>
        </Card>
        <Card
          title={t.plan.performanceTitle}
          actions={
            <Link href="/performance" className="inline-flex min-h-[24px] items-center text-2xs text-accent hover:underline">
              {t.nav.performance}
            </Link>
          }
        >
          <p className="text-xs text-ink-muted">
            {validations.size === 0
              ? t.plan.performanceBody
              : validatedCount === 0
                ? t.perf.noneValidated
                : t.perf.validatedCount(validatedCount, validations.size)}
          </p>
        </Card>
      </div>

      <WarningNote>{t.plan.riskWarning}</WarningNote>
    </div>
  );
}

const HERO_TONE = {
  buy: 'border-up/50',
  wait: 'border-accent/50',
  neutral: 'border-line-strong',
  warn: 'border-warn/50',
} as const;

const HEADLINE_TONE = { buy: 'text-up', wait: 'text-accent', neutral: 'text-ink', warn: 'text-warn' } as const;

function Hero({
  tone,
  title,
  body,
  children,
}: {
  tone: keyof typeof HERO_TONE;
  title: string;
  body?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className={`rounded-lg border-2 bg-bg-raised p-5 ${HERO_TONE[tone]}`}>
      <h1 className={`text-xl font-semibold leading-snug ${HEADLINE_TONE[tone]}`}>{title}</h1>
      {body && <p className="mt-2 max-w-3xl text-sm text-ink-muted">{body}</p>}
      {children && <div className="mt-4 space-y-4">{children}</div>}
    </section>
  );
}

function Decision({
  t,
  decision,
  top,
  topAi,
  summary,
  rejected,
  now,
}: {
  t: Messages;
  decision: string;
  top: StoredSetup | null;
  topAi: Awaited<ReturnType<typeof analysisForSetup>> | null;
  summary: ScanSummary | null;
  rejected: StoredSetup[];
  now: number;
}) {
  if (decision === 'DATA_UNAVAILABLE') {
    return <Hero tone="warn" title={t.plan.decisionDataUnavailable} body={t.plan.decisionDataUnavailableBody} />;
  }
  if (decision === 'DAILY_STOP') {
    return (
      <Hero
        tone="warn"
        title={t.plan.decisionDailyStop}
        body={t.plan.decisionDailyStopBody((summary?.dailyLossPercent ?? 0).toFixed(2), summary?.maxDailyLossPercent ?? 0)}
      />
    );
  }
  if (decision === 'POSITIONS_FULL') {
    return (
      <Hero
        tone="warn"
        title={t.plan.decisionPositionsFull}
        body={t.plan.decisionPositionsFullBody(summary?.openPositions ?? 0, summary?.maxOpenPositions ?? 0)}
      />
    );
  }

  if (top && (top.state === 'BUY_NOW' || top.state === 'WAIT_FOR_ENTRY')) {
    const p = top.plan;
    const headline = `${pairLabel(p)} · ${timeframeLabel(t, p.timeframe)} · ${strategyLabel(t, p.strategyId)}`;
    const line = actionLine(t, p, top.state, top.state_reason);
    return (
      <Hero
        tone={top.state === 'BUY_NOW' ? 'buy' : 'wait'}
        title={top.state === 'BUY_NOW' ? t.plan.decisionBuyNow(headline) : t.plan.decisionWait(headline)}
        body={line ?? undefined}
      >
        <ValidationNote validation={top.validation} t={t} />
        <PlanFacts plan={p} t={t} now={now} />
        <div className="flex flex-wrap items-start gap-2">
          <SimulateButton setupId={top.id} labels={simulateLabels(t)} />
          <Link
            href={`/opportunities/${top.id}`}
            className="inline-flex min-h-[44px] items-center rounded border border-accent/40 bg-accent-dim px-3 text-xs font-semibold text-accent hover:bg-accent/20"
          >
            {t.plan.openPlan}
          </Link>
          <Link
            href={`/opportunities/${top.id}#record`}
            className="inline-flex min-h-[44px] items-center rounded border border-line-strong px-3 text-xs text-ink-muted hover:text-ink"
          >
            {t.plan.alreadyBought}
          </Link>
        </div>
        {topAi?.ai && (
          <div className="rounded border border-line bg-bg-inset px-3 py-2">
            <h2 className="text-xs font-semibold text-ink">{t.plan.aiNoteTitle}</h2>
            <p className="mt-1 text-xs text-ink-muted">{topAi.ai.finalAssessment}</p>
            <p className="mt-1 text-2xs text-ink-faint">
              {t.plan.aiNoteSource(topAi.aiModel ?? topAi.aiProvider, formatWib(topAi.generatedAtMs))}
            </p>
          </div>
        )}
        <WhySection plan={p} t={t} />
      </Hero>
    );
  }

  return (
    <Hero tone="neutral" title={t.plan.decisionNoTrade} body={t.plan.decisionNoTradeBody}>
      {summary && summary.pairs.length > 0 && <MarketConditions t={t} summary={summary} />}
      {rejected.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-ink">{t.plan.rejectedTitle(rejected.length)}</h2>
          <ul className="mt-2 space-y-1 text-2xs text-ink-muted">
            {rejected.slice(0, 5).map((s) => (
              <li key={s.id}>
                <Link href={`/opportunities/${s.id}`} className="text-accent hover:underline">
                  {pairLabel(s.plan)} · {timeframeLabel(t, s.plan.timeframe)}
                </Link>{' '}
                — {s.plan.eligibility.failures.map((f) => failureText(t, s.plan, f)).join('; ')}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Hero>
  );
}

function MarketConditions({ t, summary }: { t: Messages; summary: ScanSummary }) {
  const label: Record<string, string> = {
    uptrend: t.plan.regimeUptrend,
    downtrend: t.plan.regimeDowntrend,
    sideways: t.plan.regimeSideways,
    high_volatility: t.plan.regimeHighVol,
    low_volatility: t.plan.regimeLowVol,
    uncertain: t.plan.regimeUncertain,
  };
  const counts = new Map<string, number>();
  for (const p of summary.pairs) {
    const key = p.regime ? (label[p.regime] ?? p.regime) : t.plan.regimeNoData;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const contextUp = summary.pairs.filter((p) => p.contextUp === true).length;
  return (
    <div>
      <h2 className="text-xs font-semibold text-ink">{t.plan.whyNoTradeTitle}</h2>
      <p className="mt-1 text-2xs text-ink-muted">{t.plan.whyNoTradeBody(summary.pairs.length)}</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {[...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([name, n]) => (
            <li key={name} className="rounded border border-line bg-bg-inset px-2 py-1 text-2xs text-ink-muted">
              <span className="num font-semibold text-ink">{n}</span> × {name}
            </li>
          ))}
        <li className="rounded border border-line bg-bg-inset px-2 py-1 text-2xs text-ink-muted">{t.plan.contextUpCount(contextUp)}</li>
      </ul>
    </div>
  );
}

function SetupRow({ s, t }: { s: StoredSetup; t: Messages }) {
  const line = actionLine(t, s.plan, s.state, s.state_reason);
  return (
    <li className="rounded border border-line bg-bg-inset px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge state={s.state} t={t} />
        <Link href={`/opportunities/${s.id}`} className="text-xs font-medium text-ink hover:text-accent">
          {pairLabel(s.plan)}
        </Link>
        <span className="text-2xs text-ink-faint">
          {timeframeLabel(t, s.plan.timeframe)} · {strategyLabel(t, s.plan.strategyId)}
        </span>
        <span className="ml-auto text-2xs text-ink-muted">
          {t.plan.riskReward} 1 : {s.plan.outcome.netRiskReward.toFixed(2)}
        </span>
      </div>
      {line && <p className="mt-1 text-2xs text-ink-muted">{line}</p>}
    </li>
  );
}
