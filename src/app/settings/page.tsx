import { features } from '@/lib/config/env';
import { listProviderStatus, listRecentJobs } from '@/lib/db/repo';
import { formatAge, formatUtc } from '@/lib/format';
import { coverageMatrix } from '@/lib/providers/registry';
import { resolveFeeds } from '@/lib/providers/news/feeds';
import { Card, InfoNote, Stat, Table, WarningNote } from '@/components/ui';
import { getLocale, getMessages } from '@/lib/i18n';
import { LOCALE_NAME } from '@/lib/i18n/types';
import { getTradingSettings } from '@/lib/settings/trading';
import { TradingSettingsForm } from './trading-form';

export const dynamic = 'force-dynamic';

/**
 * Settings is read-only with respect to secrets: it reports which providers are
 * CONFIGURED (a boolean), never the key itself. No API key or token is ever
 * sent to the browser.
 */
export default async function SettingsPage() {
  const t = await getMessages();
  const flags = features();
  const [status, jobs, locale, trading] = await Promise.all([
    listProviderStatus(),
    listRecentJobs(8),
    getLocale(),
    getTradingSettings(),
  ]);
  const providers = coverageMatrix();
  const feeds = resolveFeeds();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink">{t.settings.title}</h1>
        <p className="text-2xs text-ink-muted">{t.settings.subtitle}</p>
      </div>

      {!flags.authEnabled && (
        <WarningNote>{t.settings.authWarning}</WarningNote>
      )}

      <section id="trading">
        <Card title={t.plan.tradingTitle} subtitle={t.plan.tradingSub}>
          <TradingSettingsForm
            initial={{
              capitalIdr: trading.capitalIdr,
              reservedIdr: trading.reservedIdr,
              riskPercent: trading.riskPercent,
              maxAllocationPercent: trading.maxAllocationPercent,
              maxOpenPositions: trading.maxOpenPositions,
              maxDailyLossPercent: trading.maxDailyLossPercent,
              minNetRiskReward: trading.minNetRiskReward,
              sellTaxPercent: trading.sellTaxPercent,
              otherFeePercentPerSide: trading.otherFeePercentPerSide,
              minVolumeIdr: trading.minVolumeIdr,
              maxSpreadPercent: trading.maxSpreadPercent,
              universeSize: trading.universeSize,
              simStartCapitalIdr: trading.simStartCapitalIdr,
            }}
            autoSimulate={trading.autoSimulate}
            labels={{
              fCapital: t.plan.fCapital,
              fReserved: t.plan.fReserved,
              fRisk: t.plan.fRisk,
              fAllocation: t.plan.fAllocation,
              fMaxPositions: t.plan.fMaxPositions,
              fDailyLoss: t.plan.fDailyLoss,
              fMinRr: t.plan.fMinRr,
              fTax: t.plan.fTax,
              fOther: t.plan.fOther,
              fMinVolume: t.plan.fMinVolume,
              fMaxSpread: t.plan.fMaxSpread,
              fUniverse: t.plan.fUniverse,
              fSimCapital: t.sim.fSimCapital,
              fAutoSimulate: t.sim.fAutoSimulate,
              save: t.plan.save,
              saved: t.plan.saved,
              saveFailed: t.plan.saveFailed,
            }}
          />
        </Card>
      </section>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat
          label={t.settings.dataMode}
          value={flags.dataMode}
          sub={flags.dataMode === 'offline' ? t.settings.dataModeOffline : t.settings.dataModeReal}
        />
        <Stat
          label={t.settings.ai}
          value={flags.aiEnabled ? flags.aiProvider : t.settings.aiDisabled}
          sub={flags.aiEnabled ? flags.aiModel : t.settings.aiDeterministic}
        />
        <Stat label={t.settings.newsFeeds} value={feeds.filter((f) => f.available).length} sub={t.news.statConfigured(feeds.length)} />
        <Stat label={t.settings.telegram} value={flags.telegramEnabled ? t.settings.telegramOn : t.settings.telegramOff} />
        <Stat label={t.settings.language} value={LOCALE_NAME[locale]} />
      </div>

      <Card
        title={t.settings.coverageTitle}
        subtitle={t.settings.coverageSub}
      >
        <div className="space-y-3">
          {providers.map((p) => (
            <div key={p.id} className="rounded border border-line bg-bg-inset p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-ink">{p.label}</span>
                <span className="rounded border border-line-strong px-1.5 py-px text-2xs text-ink-muted">
                  {p.assetClass}
                </span>
                <span
                  className={`rounded border px-1.5 py-px text-2xs ${
                    p.configured ? 'border-up/30 bg-up-dim text-up' : 'border-warn/30 bg-warn-dim text-warn'
                  }`}
                >
                  {p.configured ? t.settings.configured : p.requiresKey ? t.settings.keyMissing : t.settings.disabled}
                </span>
                <span
                  className={`rounded border px-1.5 py-px text-2xs ${
                    p.capabilities.verified ? 'border-accent/30 bg-accent-dim text-accent' : 'border-line-strong text-ink-faint'
                  }`}
                >
                  {p.capabilities.verified ? t.settings.verifiedLive : t.settings.unverified}
                </span>
              </div>
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-2xs sm:grid-cols-2">
                <div>
                  <dt className="inline text-ink-faint">{t.settings.markets}: </dt>
                  <dd className="inline text-ink-muted">{p.capabilities.markets.join('; ')}</dd>
                </div>
                <div>
                  <dt className="inline text-ink-faint">{t.common.timeframe}: </dt>
                  <dd className="inline text-ink-muted">{p.capabilities.timeframes.join(', ')}</dd>
                </div>
                <div>
                  <dt className="inline text-ink-faint">{t.settings.delay}: </dt>
                  <dd className="inline text-ink-muted">
                    {p.capabilities.delay.kind === 'delayed'
                      ? `${p.capabilities.delay.minutes} minutes`
                      : p.capabilities.delay.kind.replace(/_/g, ' ')}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-ink-faint">{t.settings.quota}: </dt>
                  <dd className="inline text-ink-muted">{p.capabilities.quota ?? t.settings.notPublished}</dd>
                </div>
              </dl>
              <ul className="mt-2 space-y-0.5">
                {p.capabilities.limitations.map((l, i) => (
                  <li key={i} className="text-2xs text-warn">
                    · {l}
                  </li>
                ))}
              </ul>
              <a
                href={p.capabilities.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex min-h-[24px] items-center text-2xs text-accent hover:underline"
              >
                {t.settings.providerDocs}
              </a>
            </div>
          ))}
        </div>
      </Card>

      <Card title={t.settings.statusTitle} subtitle={t.settings.statusSub}>
        {status.length === 0 ? (
          <p className="text-2xs text-ink-faint">{t.settings.noCalls}</p>
        ) : (
          <Table
            head={[
              'Provider',
              t.settings.operation,
              t.settings.lastSuccess,
              t.settings.lastError,
              t.settings.consecutiveFailures,
              t.settings.callsToday,
              t.settings.rateLimitedUntil,
            ]}
          >
            {status.map((s) => (
              <tr key={`${s.provider}-${s.operation}`}>
                <td className="px-2 py-2 text-xs text-ink">{s.provider}</td>
                <td className="px-2 py-2 text-2xs text-ink-muted">{s.operation}</td>
                <td className="px-2 py-2 text-2xs text-ink-muted">{formatAge(s.last_ok_ms)}</td>
                <td className="max-w-[320px] truncate px-2 py-2 text-2xs text-down" title={s.last_error ?? ''}>
                  {s.last_error ?? '—'}
                </td>
                <td className={`num px-2 py-2 ${s.consecutive_failures > 0 ? 'text-down' : 'text-ink-muted'}`}>
                  {s.consecutive_failures}
                </td>
                <td className="num px-2 py-2 text-ink-muted">{s.calls_today}</td>
                <td className="px-2 py-2 text-2xs text-ink-faint">
                  {s.rate_limited_until_ms ? formatUtc(s.rate_limited_until_ms) : '—'}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title={t.settings.jobsTitle}>
        {jobs.length === 0 ? (
          <p className="text-2xs text-ink-faint">{t.settings.noJobs}</p>
        ) : (
          <Table head={[t.settings.job, t.settings.started, t.settings.durationLabel, t.common.status, t.settings.summary]}>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className="px-2 py-2 text-xs text-ink">{j.job}</td>
                <td className="px-2 py-2 text-2xs text-ink-muted">{formatUtc(j.started_at_ms)}</td>
                <td className="num px-2 py-2 text-2xs text-ink-muted">
                  {j.finished_at_ms ? `${((j.finished_at_ms - j.started_at_ms) / 1000).toFixed(1)}s` : t.settings.running}
                </td>
                <td
                  className={`px-2 py-2 text-2xs ${
                    j.status === 'ok' ? 'text-up' : j.status === 'error' ? 'text-down' : 'text-warn'
                  }`}
                >
                  {j.status}
                </td>
                <td className="max-w-[420px] truncate px-2 py-2 text-2xs text-ink-faint" title={j.summary_json ?? ''}>
                  {j.error ?? j.summary_json ?? '—'}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <InfoNote>{t.settings.footer}</InfoNote>
    </div>
  );
}
