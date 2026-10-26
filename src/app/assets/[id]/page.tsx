import Link from 'next/link';
import { notFound } from 'next/navigation';
import { analyzeAsset } from '@/lib/analysis/service';
import { features, riskDefaults } from '@/lib/config/env';
import { getAssetById } from '@/lib/db/repo';
import { formatAge, formatIndicator, formatNumber, formatPercent, formatPercentSigned, formatPrice, formatUtc } from '@/lib/format';
import { closedOnly } from '@/lib/market/normalize';
import { ema } from '@/lib/indicators';
import { getSeries } from '@/lib/market/service';
import { isTimeframe, STYLE_TIMEFRAMES, styleForTimeframe, type Timeframe } from '@/lib/market/types';
import { listArticlesForAsset } from '@/lib/news/repo';
import { ensureDefaultWatchlist, listWatchlist } from '@/lib/db/repo';
import { AddToWatchlistButton } from '@/app/markets/catalog-actions';
import { computeRisk, defaultCostAssumptions } from '@/lib/signals/risk';
import { listSignals } from '@/lib/signals/repo';
import { PriceChart } from '@/components/price-chart';
import { ThresholdForm, type ThresholdRow } from './threshold-form';
import { db } from '@/lib/db/driver';
import {
  ActionBadge,
  AiBadge,
  Card,
  DataQualityBadge,
  DataSourceLine,
  ErrorState,
  InfoNote,
  Stat,
  StrengthBadge,
  WarningNote,
} from '@/components/ui';
import { getMessages } from '@/lib/i18n';
import { aiPanelLabels } from '@/lib/i18n/client-labels';
import { actionHint } from '@/components/scan-table';
import { AnalysisPanel } from './analysis-panel';

export const dynamic = 'force-dynamic';

export default async function AssetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tf?: string }>;
}) {
  const t = await getMessages();
  const { id } = await params;
  const { tf } = await searchParams;

  const asset = await getAssetById(id);
  if (!asset) notFound();

  const timeframe: Timeframe = isTimeframe(tf) ? tf : '1d';
  const style = styleForTimeframe(timeframe);

  const watchlistId = await ensureDefaultWatchlist();
  const tracked = (await listWatchlist(watchlistId)).some((w) => w.id === asset.id);

  const [result, analysis, signals, articles] = await Promise.all([
    getSeries(asset, timeframe, { limit: 320, minBars: 50 }),
    // allowAiCall is false: rendering a page never spends AI budget.
    analyzeAsset(asset, timeframe, { allowAiCall: false }),
    listSignals({ assetId: asset.id, limit: 10 }),
    listArticlesForAsset(asset.id, 8),
  ]);

  const flags = features();

  // Price thresholds for this asset. Plain numbers the user chose; they are
  // deliberately NOT part of the strategy pipeline.
  const thresholdRows = await (await db()).all<ThresholdRow>(
    `SELECT id, direction, price, active, triggered_at_ms
       FROM price_thresholds WHERE asset_id = ? ORDER BY created_at_ms DESC`,
    [asset.id],
  );
  const risk = riskDefaults();
  const candles = result.series?.candles ?? [];
  const closed = closedOnly(candles);
  const latest = candles.at(-1) ?? null;
  const prevClose = closed.at(-2)?.close ?? null;
  const changePct = prevClose && latest ? ((latest.close - prevClose) / prevClose) * 100 : null;

  const buy = analysis.strategies.find((s) => s.output.action === 'BUY' && s.output.levels);
  const levels = buy?.output.levels ?? null;

  // Overlays are computed on the SAME closed-bar series the strategies use, so
  // what you see on the chart is what the rules saw.
  const overlayCloses = closed.map((c) => c.close);
  const padToAll = (series: (number | null)[]): (number | null)[] => [
    ...series,
    ...new Array(candles.length - closed.length).fill(null),
  ];
  const emaOverlays =
    closed.length >= 50
      ? [
          { label: 'EMA 20', color: 'rgba(61,139,253,0.85)', values: padToAll(ema(overlayCloses, 20)) },
          { label: 'EMA 50', color: 'rgba(210,153,34,0.85)', values: padToAll(ema(overlayCloses, 50)) },
          ...(closed.length >= 200
            ? [{ label: 'EMA 200', color: 'rgba(139,151,168,0.8)', values: padToAll(ema(overlayCloses, 200)) }]
            : []),
        ]
      : undefined;

  const costs = defaultCostAssumptions(asset.assetClass);
  const sizing = levels
    ? computeRisk({
        entry: latest?.close ?? 0,
        stop: levels.stopLoss,
        targets: [levels.takeProfit1, ...(levels.takeProfit2 ? [levels.takeProfit2] : [])],
        accountEquity: risk.accountEquity,
        riskPercentPerTrade: risk.riskPercentPerTrade,
        feeBps: costs.feeBps,
        slippageBps: costs.slippageBps,
        asset,
        direction: 'long',
      })
    : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-ink">
            {asset.symbol}
            <span className="text-2xs font-normal text-ink-faint">{asset.exchangeId}</span>
            <DataQualityBadge quality={result.quality} labels={t.quality} />
          </h1>
          <p className="text-2xs text-ink-muted">
            {asset.displayName} · {t.asset.quotedIn(asset.currency, style)}
          </p>
        </div>
        <div className="text-right">
          <div className="mb-1 flex justify-end">
            <AddToWatchlistButton
              symbol={asset.symbol}
              displayName={asset.displayName}
              exchangeId={asset.exchangeId}
              assetClass={asset.assetClass}
              currency={asset.currency}
              alreadyTracked={tracked}
              labels={{ track: t.markets.track, tracked: t.markets.tracked }}
            />
          </div>
          {/* The one hero figure on this view: the price everything else is about. */}
          <p className="figure text-[2.75rem] font-semibold leading-none text-ink">
            {formatPrice(latest?.close ?? null, asset.currency)}
          </p>
          <p className={`figure mt-1 text-xs ${changePct && changePct >= 0 ? 'text-up' : 'text-down'}`}>
            {formatPercentSigned(changePct)} {t.asset.vsPrevClose}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xs uppercase tracking-wide text-ink-faint">{t.common.timeframe}</span>
        {Object.entries(STYLE_TIMEFRAMES).map(([styleName, tfs]) => (
          <span key={styleName} className="flex items-center gap-1">
            <span className="text-2xs text-ink-faint">{styleName}:</span>
            {tfs.map((t) => (
              <Link
                key={`${styleName}-${t}`}
                href={`/assets/${asset.id}?tf=${t}`}
                className={`rounded px-1.5 py-0.5 text-2xs ${
                  t === timeframe ? 'bg-accent-dim text-accent' : 'text-ink-muted hover:bg-bg-inset hover:text-ink'
                }`}
              >
                {t}
              </Link>
            ))}
          </span>
        ))}
      </div>

      {!result.series ? (
        <>
          <ErrorState
            title={t.asset.noData}
            detail={result.providerError ?? t.asset.noDataBody}
          />
          {result.remedy && (
            <WarningNote>
              {t.overview.howToFix} {result.remedy}
            </WarningNote>
          )}
        </>
      ) : (
        <>
          {result.quality !== 'ok' && (
            <WarningNote>{t.asset.qualityWarning(result.quality, result.freshness?.reason ?? '')}</WarningNote>
          )}

          <Card
            title={t.asset.priceTitle(timeframe)}
            subtitle={t.asset.barsSub(closed.length, candles.length > closed.length)}
            actions={
              <span className="text-2xs text-ink-faint">
                {result.session.open ? t.asset.marketOpen : t.asset.marketClosed}
              </span>
            }
          >
            <PriceChart
              candles={candles.map((c) => ({
                time: c.openTimeMs,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume,
                isPartial: c.isPartial,
              }))}
              overlays={emaOverlays}
              labels={t.chart}
              levels={
                levels
                  ? [
                      // Validated tokens, not the superseded pair that used to
                      // be hardcoded here (#e5534b / #3fb950).
                      { price: levels.stopLoss, label: 'stop', color: '#e5484d' },
                      { price: levels.takeProfit1, label: 'TP1', color: '#13a383' },
                      ...(levels.takeProfit2 ? [{ price: levels.takeProfit2, label: 'TP2', color: '#13a383' }] : []),
                    ]
                  : []
              }
            />
            <div className="mt-3 space-y-1">
              <DataSourceLine
                provider={result.series.provider}
                fetchedAtMs={result.series.fetchedAtMs}
                fromCache={result.fromCache}
                extra={t.asset.latestClosedBar(formatUtc(result.freshness?.lastClosedCandleMs ?? null))}
                labels={{ source: t.ui.source, retrieved: t.ui.retrieved, fromCache: t.ui.fromCache, none: t.common.none }}
              />
              {result.notes.map((n, i) => (
                <p key={i} className="text-2xs text-ink-faint">
                  · {n}
                </p>
              ))}
            </div>
          </Card>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            <Stat label="RSI 14" value={formatNumber(analysis.indicators.rsi14 as number | null, 1)} hint={t.glossary.rsi} />
            <Stat label="EMA 20" value={formatPrice(analysis.indicators.ema20 as number | null)} hint={t.glossary.ema} />
            <Stat label="EMA 50" value={formatPrice(analysis.indicators.ema50 as number | null)} hint={t.glossary.ema} />
            <Stat label="EMA 200" value={formatPrice(analysis.indicators.ema200 as number | null)} hint={t.glossary.ema} />
            <Stat label="ATR 14" value={formatIndicator(analysis.indicators.atr14 as number | null)} hint={t.glossary.atr} />
            <Stat label="MACD hist" value={formatIndicator(analysis.indicators.macdHistogram as number | null)} hint={t.glossary.macdHistogram} />
            <Stat
              label={t.scanner.relVol}
              value={
                analysis.indicators.volumeAvailable
                  ? formatNumber(analysis.indicators.relativeVolume as number | null, 2)
                  : 'n/a'
              }
              sub={analysis.indicators.volumeAvailable ? undefined : t.asset.volumeUnavailable}
              hint={t.glossary.relativeVolume}
            />
            <Stat label={t.common.regime} value={analysis.regime.replace(/_/g, ' ')} hint={t.glossary.regime} />
          </div>

          <Card title={t.asset.strategyEval} subtitle={analysis.regimeExplanation}>
            <div className="space-y-3">
              {analysis.strategies.length === 0 && (
                <p className="text-2xs text-ink-faint">{t.asset.noStrategy}</p>
              )}
              {analysis.strategies.map((s) => (
                <div key={s.strategyId} className="rounded border border-line bg-bg-inset p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <ActionBadge action={s.output.action} hint={actionHint(t, s.output.action)} />
                    <span className="text-xs font-medium text-ink">{s.strategyId}</span>
                    <span className="text-2xs text-ink-faint">@{s.version}</span>
                    <StrengthBadge strength={s.output.strength} labels={t.strength} />
                  </div>
                  <p className="mt-1.5 text-2xs text-ink-muted">{s.output.summary}</p>
                  {s.output.rules.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {s.output.rules.map((r) => (
                        <li key={r.id} className="flex gap-2 text-2xs">
                          <span
                            className={`shrink-0 font-semibold ${
                              r.skipped ? 'text-ink-faint' : r.passed ? 'text-up' : 'text-down'
                            }`}
                          >
                            {r.skipped ? t.ui.skip : r.passed ? t.ui.pass : t.ui.fail}
                          </span>
                          <span className="text-ink-muted">
                            {r.id} {r.description} — <span className="text-ink-faint">{r.detail}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {s.output.invalidation.length > 0 && (
                    <p className="mt-2 text-2xs text-ink-faint">
                      {t.asset.invalidation} {s.output.invalidation.join(' · ')}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {sizing && (
            <Card
              title={t.asset.riskTitle}
              subtitle={t.asset.riskSub(formatNumber(risk.accountEquity, 0), risk.riskPercentPerTrade)}
            >
              {!sizing.ok ? (
                <ErrorState title={t.asset.sizeNotCalculated} detail={sizing.refusals.join('\n')} />
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    <Stat label={t.asset.riskPerUnit} value={formatIndicator(sizing.riskPerUnit)} hint={t.glossary.stopLoss} />
                    <Stat label={t.asset.stopDistance} value={formatPercent(sizing.stopDistancePct)} hint={t.glossary.stopLoss} />
                    <Stat label={t.asset.positionSize} value={formatNumber(sizing.positionSize, 6)} sub={t.signals.units} hint={t.glossary.positionSize} />
                    <Stat label={t.asset.notional} value={formatNumber(sizing.positionNotional, 2)} sub={asset.currency} />
                    <Stat label={t.asset.riskAmount} value={formatNumber(sizing.riskAmount, 2)} sub={asset.currency} hint={t.glossary.riskPerTrade} />
                    <Stat label={t.asset.rrNet} value={formatNumber(sizing.riskRewardNet, 2)} sub={t.asset.rrGross(formatNumber(sizing.riskReward, 2))} hint={t.glossary.riskReward} />
                  </div>
                  <p className="mt-3 text-2xs text-ink-faint">{sizing.costAssumptionNote}</p>
                  {sizing.disclosures.map((d, i) => (
                    <p key={i} className="mt-1 text-2xs text-warn">
                      · {d}
                    </p>
                  ))}
                </>
              )}
            </Card>
          )}

          <Card
            title={t.asset.aiTitle}
            subtitle={t.asset.aiSub}
            actions={<AiBadge status={analysis.aiStatus} provider={analysis.aiProvider} labels={t.ui} />}
          >
            <AnalysisPanel
              assetId={asset.id}
              timeframe={timeframe}
              aiEnabled={flags.aiEnabled}
              t={aiPanelLabels(t)}
              initial={{
                aiStatus: analysis.aiStatus,
                aiProvider: analysis.aiProvider,
                aiModel: analysis.aiModel,
                aiError: analysis.aiError,
                ai: analysis.ai,
              }}
            />
          </Card>
        </>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={t.asset.signalsForAsset}>
          {signals.length === 0 ? (
            <p className="text-2xs text-ink-faint">{t.asset.noSignalsYet}</p>
          ) : (
            <ul className="space-y-1.5">
              {signals.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2 text-2xs">
                  <ActionBadge action={s.action} hint={actionHint(t, s.action)} />
                  <Link href={`/signals/${s.id}`} className="text-ink hover:text-accent">
                    {s.strategy_id} · {s.timeframe}
                  </Link>
                  <span className="text-ink-faint">{s.status}</span>
                  <span className="ml-auto text-ink-faint">{formatAge(s.generated_at_ms)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t.asset.relatedNews} subtitle={t.asset.relatedNewsSub}>
          {articles.length === 0 ? (
            <p className="text-2xs text-ink-faint">
              {t.asset.noMatchedArticles} {flags.newsEnabled ? t.asset.runNewsJob : t.asset.noNewsConfigured}
            </p>
          ) : (
            <ul className="space-y-2">
              {articles.map((a) => (
                <li key={a.id}>
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-2xs text-ink hover:text-accent"
                  >
                    {a.headline}
                  </a>
                  <p className="text-2xs text-ink-faint">
                    {a.publisher} · {formatUtc(a.published_at_ms)} · {a.category} · {t.asset.matched} {a.match_reason}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={t.threshold.title} subtitle={t.threshold.subtitle}>
        <ThresholdForm
          assetId={asset.id}
          currency={asset.currency}
          rows={thresholdRows}
          labels={{
            direction: t.threshold.direction,
            above: t.threshold.above,
            below: t.threshold.below,
            price: t.threshold.price,
            add: t.threshold.add,
            adding: t.threshold.adding,
            added: t.threshold.added,
            failed: t.threshold.failed,
            none: t.threshold.none,
            active: t.threshold.active,
            triggered: t.threshold.triggered,
            remove: t.threshold.remove,
            listTitle: t.threshold.listTitle,
          }}
        />
        <div className="mt-3">
          <WarningNote>{t.threshold.notSignal}</WarningNote>
        </div>
      </Card>

      <InfoNote>
        {t.asset.footer(
          formatUtc(analysis.analysisTimeMs),
          formatUtc(analysis.latestCandleMs),
          formatUtc(analysis.dataFetchedMs),
        )}
      </InfoNote>
    </div>
  );
}
