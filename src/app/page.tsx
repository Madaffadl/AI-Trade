import Link from 'next/link';
import { features } from '@/lib/config/env';
import { listRecentJobs, listProviderStatus } from '@/lib/db/repo';
import { scanWatchlist } from '@/lib/market/scanner';
import { countArticles, listArticles } from '@/lib/news/repo';
import { listAlerts } from '@/lib/notifications/repo';
import { listSignals } from '@/lib/signals/repo';
import { ScanTable } from '@/components/scan-table';
import { BeginnerGuide } from '@/components/beginner-guide';
import { FxDisclosure } from '@/components/money';
import { fxContext, getDisplayCurrencySetting } from '@/lib/fx/service';
import { getMessages } from '@/lib/i18n';
import { ActionBadge, Card, DataQualityBadge, EmptyState, InfoNote, Stat, StrengthBadge, WarningNote } from '@/components/ui';
import { formatAge, formatUtc } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Overview dashboard.
 *
 * Reads only from the database and the market service cache; it does not force
 * provider refreshes on render, so navigating around the app costs no API quota.
 */
export default async function OverviewPage() {
  const flags = features();
  const t = await getMessages();
  const display = await getDisplayCurrencySetting();
  const fx = await fxContext(display);
  const [rows, signals, alerts, articles, jobs, providers, articleCount] = await Promise.all([
    scanWatchlist(),
    listSignals({ limit: 8 }),
    listAlerts(6),
    listArticles(5),
    listRecentJobs(1),
    listProviderStatus(),
    countArticles(),
  ]);

  const lastJob = jobs[0];
  const degraded = rows.filter((r) => r.quality !== 'ok');
  const failingProviders = providers.filter((p) => p.consecutive_failures > 0);
  const actionable = signals.filter((s) => s.action === 'BUY' || s.action === 'SELL');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t.overview.title}</h1>
          <p className="text-2xs text-ink-muted">
            {t.overview.subtitle(
              rows.length,
              flags.dataMode,
              flags.aiEnabled ? t.overview.aiVia(flags.aiProvider) : t.overview.aiDisabled,
            )}
          </p>
        </div>
        <p className="text-2xs text-ink-faint">
          {t.overview.lastJob(lastJob ? `${formatUtc(lastJob.started_at_ms)} (${lastJob.status})` : t.overview.neverRun)}
        </p>
      </div>

      <BeginnerGuide labels={t.guide} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label={t.overview.statWatchlist} value={rows.length} sub={t.overview.statWatchlistSub} />
        <Stat
          label={t.overview.statUsable}
          value={`${rows.length - degraded.length}/${rows.length}`}
          sub={t.overview.statUsableSub}
          tone={degraded.length > 0 ? 'text-warn' : 'text-up'}
        />
        <Stat label={t.overview.statSignals} value={actionable.length} sub={t.overview.statSignalsSub} />
        <Stat label={t.overview.statAlerts} value={alerts.filter((a) => a.read_at_ms === null).length} sub={t.overview.statAlertsSub} />
        <Stat
          label={t.overview.statNews}
          value={articleCount}
          sub={flags.newsEnabled ? t.overview.statNewsFeeds(flags.newsFeeds.length) : t.overview.statNewsNoFeeds}
        />
      </div>

      {failingProviders.length > 0 && (
        <WarningNote>
          {t.overview.providerIssues}{' '}
          {failingProviders
            .map((p) => `${p.provider}/${p.operation} — ${p.consecutive_failures} consecutive failure(s): ${p.last_error ?? 'unknown'}`)
            .join(' · ')}
        </WarningNote>
      )}

      <Card
        title={t.overview.scanTitle}
        subtitle={t.overview.scanSubtitle}
        actions={
          <Link href="/scanner" className="inline-flex min-h-[24px] items-center text-2xs text-accent hover:underline">
            {t.overview.openScanner}
          </Link>
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            title={t.overview.noAssets}
            body={t.overview.noAssetsBody}
          />
        ) : (
          <ScanTable rows={rows} fx={fx} t={t} />
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title={t.overview.recentSignals}
          subtitle={t.overview.recentSignalsSub}
          actions={
            <Link href="/signals" className="inline-flex min-h-[24px] items-center text-2xs text-accent hover:underline">
              {t.overview.allSignals}
            </Link>
          }
        >
          {signals.length === 0 ? (
            <EmptyState
              title={t.overview.noSignals}
              body={t.overview.noSignalsBody}
            />
          ) : (
            <ul className="space-y-2">
              {signals.map((s) => (
                <li key={s.id} className="rounded border border-line bg-bg-inset px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <ActionBadge action={s.action} />
                    <Link href={`/signals/${s.id}`} className="text-xs font-medium text-ink hover:text-accent">
                      {s.symbol}
                    </Link>
                    <span className="text-2xs text-ink-faint">{s.timeframe} · {s.strategy_id}</span>
                    <StrengthBadge strength={s.strength} labels={t.strength} />
                    <span className="ml-auto text-2xs text-ink-faint">{formatAge(s.generated_at_ms)}</span>
                  </div>
                  <p className="mt-1 text-2xs text-ink-muted">
                    R:R {s.risk_reward === null ? '—' : s.risk_reward.toFixed(2)} · regime {s.regime} · data{' '}
                    {s.data_quality}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={t.overview.latestNews}
          subtitle={t.overview.latestNewsSub}
          actions={
            <Link href="/news" className="inline-flex min-h-[24px] items-center text-2xs text-accent hover:underline">
              {t.overview.newsLink}
            </Link>
          }
        >
          {articles.length === 0 ? (
            <EmptyState
              title={t.overview.noNews}
              body={t.overview.noNewsBody}
            />
          ) : (
            <ul className="space-y-2">
              {articles.map((a) => (
                <li key={a.id} className="rounded border border-line bg-bg-inset px-3 py-2">
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex min-h-[24px] items-center text-xs text-ink transition-colors hover:text-accent"
                  >
                    {a.headline}
                  </a>
                  <p className="mt-1 text-2xs text-ink-faint">
                    {a.publisher} · {t.overview.published} {formatUtc(a.published_at_ms)} · {t.ui.retrieved}{' '}
                    {formatAge(a.fetched_at_ms)} · {a.category}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {degraded.length > 0 && (
        <Card title={t.overview.degradedTitle} subtitle={t.overview.degradedSub}>
          <ul className="space-y-2.5">
            {degraded.map((r) => (
              <li key={r.assetId}>
                <div className="flex flex-wrap items-center gap-2 text-2xs">
                  <DataQualityBadge quality={r.quality} labels={t.quality} />
                  <span className="font-medium text-ink">{r.symbol}</span>
                  <span className="text-ink-muted">{r.error ?? r.reasons[0] ?? t.overview.noDetail}</span>
                </div>
                {r.remedy && (
                  <p className="ml-1 mt-1 border-l border-line-strong pl-2 text-2xs text-accent">
                    {t.overview.howToFix} {r.remedy}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <FxDisclosure target={display} providerUpdatedAtMs={fx.rates?.providerUpdatedAtMs ?? null} />

      <InfoNote>
        {t.overview.footer}{' '}
        <Link href="/evaluation" className="text-accent hover:underline">
          {t.overview.footerLink}
        </Link>
        {t.overview.footerTail}
      </InfoNote>
    </div>
  );
}
