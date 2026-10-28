import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AnalysisPanel } from '@/app/assets/[id]/analysis-panel';
import { RecordBuyForm } from '@/app/portfolio/position-forms';
import { PriceChart } from '@/components/price-chart';
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
import { analysisForSetup } from '@/lib/analysis/service';
import { features } from '@/lib/config/env';
import { listAssets, loadCandles, nowMs } from '@/lib/db/repo';
import { formatWib } from '@/lib/format';
import { getMessages } from '@/lib/i18n';
import { SimulateButton } from '@/components/plan/simulate-button';
import { aiPanelLabels, positionFormLabels, simulateLabels } from '@/lib/i18n/client-labels';
import { styleForTimeframe, type Timeframe } from '@/lib/market/types';
import { monitorHeartbeat } from '@/lib/jobs/monitor';
import { getSetup } from '@/lib/plan/repo';
import { MAX_QUOTE_AGE_MS } from '@/lib/plan/states';

export const dynamic = 'force-dynamic';

/** The complete plan for one setup: what to do, every number, the costs, the chart, the reasons. */
export default async function SetupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const setup = await getSetup(id);
  if (!setup) notFound();

  const t = await getMessages();
  const now = nowMs();
  const p = setup.plan;
  const timeframe = p.timeframe as Timeframe;
  const [stored, ai, assets, heartbeat] = await Promise.all([
    loadCandles(p.assetId, timeframe, 200),
    analysisForSetup(setup),
    listAssets('crypto'),
    monitorHeartbeat(),
  ]);
  const line = actionLine(t, p, setup.state, setup.state_reason);
  // The live monitor re-checks every setup of the latest scan each minute but
  // only writes the row when its state changes.
  const checkedAt = Math.max(setup.updated_at_ms, heartbeat?.scanId === setup.last_scan_id ? heartbeat.checkedAtMs : 0);
  const stale = now - checkedAt > MAX_QUOTE_AGE_MS;
  const pct = (v: number) => v.toFixed(v < 0.1 ? 4 : 2);

  return (
    <div className="space-y-5">
      <Link href="/opportunities" className="inline-flex min-h-[24px] items-center text-2xs text-accent hover:underline">
        ← {t.plan.back}
      </Link>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={setup.state} t={t} />
          <span className="text-2xs text-ink-faint">{formatWib(setup.updated_at_ms)}</span>
        </div>
        <h1 className="text-xl font-semibold text-ink">
          {pairLabel(p)} · {timeframeLabel(t, p.timeframe)} · {strategyLabel(t, p.strategyId)}
        </h1>
        {line && <p className="text-sm text-ink">{line}</p>}
        {setup.state === 'NOT_ELIGIBLE' && (
          <ul className="list-disc pl-4 text-xs text-down">
            {p.eligibility.failures.map((f) => (
              <li key={f}>{failureText(t, p, f)}</li>
            ))}
          </ul>
        )}
        <ValidationNote validation={setup.validation} t={t} />
      </div>

      {stale && <WarningNote>{t.plan.staleBody(Math.round((now - checkedAt) / 60_000))}</WarningNote>}

      <Card title={t.plan.title}>
        <PlanFacts plan={p} t={t} now={now} />
        {(setup.state === 'BUY_NOW' || setup.state === 'WAIT_FOR_ENTRY') && (
          <div className="mt-4 flex flex-wrap items-start gap-3">
            <SimulateButton setupId={setup.id} labels={simulateLabels(t)} />
            <Link
              href="#record"
              className="inline-flex min-h-[44px] items-center rounded border border-line-strong px-3 text-xs text-ink-muted hover:text-ink"
            >
              {t.plan.alreadyBought}
            </Link>
          </div>
        )}
      </Card>

      <Card title={t.plan.costsTitle}>
        <ul className="space-y-1 text-2xs text-ink-muted">
          <li>{t.plan.costFee(pct(p.costs.buyFeePercent))}</li>
          <li>{t.plan.costTax(pct(p.costs.sellTaxPercent))}</li>
          <li>{t.plan.costOther(pct(p.costs.otherPercentPerSide))}</li>
          <li>{t.plan.costSpread(pct(p.costs.halfSpreadPercent))}</li>
          <li className="font-semibold text-ink">
            {t.plan.costs}: {p.costs.roundTripPercent.toFixed(2)}%
          </li>
        </ul>
      </Card>

      {stored.candles.length > 0 && (
        <Card title={t.plan.chartTitle} subtitle={t.plan.source(formatWib(stored.fetchedAtMs))}>
          <PriceChart
            candles={stored.candles.map((c) => ({
              time: c.openTimeMs,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
              isPartial: c.isPartial,
            }))}
            labels={t.chart}
            levels={[
              { price: p.entry.planned, label: t.plan.entry, color: '#3d8bfd' },
              { price: p.entry.max, label: t.plan.maxEntry, color: '#8b97a8' },
              { price: p.stopLoss, label: t.plan.stopLoss, color: '#e5484d' },
              { price: p.takeProfit1, label: t.plan.target1, color: '#13a383' },
              ...(p.takeProfit2 !== null ? [{ price: p.takeProfit2, label: t.plan.target2, color: '#13a383' }] : []),
            ]}
          />
        </Card>
      )}

      <WhySection plan={p} t={t} open />

      <Card title={t.plan.aiTitle}>
        <AnalysisPanel
          assetId={p.assetId}
          timeframe={timeframe}
          setupId={setup.id}
          aiEnabled={features().aiEnabled}
          t={aiPanelLabels(t)}
          initial={ai}
        />
      </Card>

      <section id="record">
        <Card title={t.plan.recordTitle} subtitle={t.plan.recordBody}>
          <RecordBuyForm
            t={positionFormLabels(t)}
            assets={assets
              .filter((a) => a.exchangeId === 'INDODAX')
              .map((a) => ({ id: a.id, symbol: a.symbol, displayName: a.displayName, exchangeId: a.exchangeId, currency: a.currency }))}
            prefill={{
              assetId: p.assetId,
              entryPrice: p.entry.planned,
              stopLoss: p.stopLoss,
              takeProfit1: p.takeProfit1,
              takeProfit2: p.takeProfit2 ?? undefined,
              timeframe: p.timeframe,
              tradingStyle: styleForTimeframe(timeframe),
              signalId: setup.signal_id ?? undefined,
            }}
          />
        </Card>
      </section>
    </div>
  );
}
