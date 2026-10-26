import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSignal } from '@/lib/signals/repo';
import { listAssets } from '@/lib/db/repo';
import { RecordBuyForm as BuyFromSignal } from '@/app/portfolio/position-forms';
import { getMessages } from '@/lib/i18n';
import { positionFormLabels } from '@/lib/i18n/client-labels';
import { db } from '@/lib/db/driver';
import { ActionBadge, Card, InfoNote, Stat, StrengthBadge, WarningNote } from '@/components/ui';
import { actionHint } from '@/components/scan-table';
import { formatIndicator, formatNumber, formatPercent, formatPercentSigned, formatPrice, formatUtc } from '@/lib/format';
import type { RuleOutcome } from '@/lib/strategies/types';

export const dynamic = 'force-dynamic';

interface Reasons {
  summary: string;
  rules: RuleOutcome[];
}

export default async function SignalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getMessages();
  const formLabels = positionFormLabels(t);
  const { id } = await params;
  const signal = await getSignal(id);
  if (!signal) notFound();

  const assetOptions = (await listAssets()).map((a) => ({
    id: a.id,
    symbol: a.symbol,
    displayName: a.displayName,
    exchangeId: a.exchangeId,
    currency: a.currency,
  }));

  const parse = <T,>(json: string | null, fallback: T): T => {
    if (!json) return fallback;
    try {
      return JSON.parse(json) as T;
    } catch {
      return fallback;
    }
  };

  const reasons = parse<Reasons>(signal.reasons_json, { summary: '', rules: [] });
  const risks = parse<string[]>(signal.risks_json, []);
  const invalidation = parse<string[]>(signal.invalidation_json, []);
  const indicators = parse<Record<string, unknown>>(signal.indicators_json, {});

  const d = await db();
  const evaluation = await d.get<{
    outcome: string;
    return_pct_net: number | null;
    r_multiple: number | null;
    bars_observed: number;
    exit_reason: string | null;
    max_favorable_excursion: number | null;
    max_adverse_excursion: number | null;
    fee_assumption_bps: number;
    slippage_assumption_bps: number;
    overlaps_prior: number;
  }>('SELECT * FROM signal_evaluations WHERE signal_id = ? ORDER BY evaluated_at_ms DESC LIMIT 1', [id]);

  const riskPerUnit =
    signal.stop_loss !== null ? signal.price_at_signal - signal.stop_loss : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <ActionBadge action={signal.action} size="lg" hint={actionHint(t, signal.action)} />
        <div>
          <h1 className="text-lg font-semibold text-ink">
            {signal.symbol} <span className="text-2xs font-normal text-ink-faint">{signal.exchange_id}</span>
          </h1>
          <p className="text-2xs text-ink-muted">
            {signal.display_name} · {signal.timeframe} · {signal.trading_style}
          </p>
        </div>
        <StrengthBadge strength={signal.strength} labels={t.strength} />
        <span className="ml-auto text-2xs text-ink-faint">
          {signal.strategy_id}@{signal.strategy_version} · status {signal.status}
        </span>
      </div>

      {signal.action === 'SELL' && (
        <WarningNote>{t.signals.sellWarning}</WarningNote>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label={t.common.price} value={formatPrice(signal.price_at_signal, signal.currency)} />
        <Stat hint={t.glossary.entry} label={t.signals.entry} value={signal.entry_low === null ? '—' : `${formatPrice(signal.entry_low)}–${formatPrice(signal.entry_high)}`} />
        <Stat hint={t.glossary.stopLoss} label={t.signals.stop} value={formatPrice(signal.stop_loss)} tone="text-down" sub={riskPerUnit !== null ? `risk/unit ${formatNumber(riskPerUnit, 4)}` : undefined} />
        <Stat label="TP1" value={formatPrice(signal.take_profit_1)} tone="text-up" hint={t.glossary.takeProfit} />
        <Stat label="TP2" value={formatPrice(signal.take_profit_2)} tone="text-up" hint={t.glossary.takeProfit} />
        <Stat label="R:R" value={formatNumber(signal.risk_reward, 2)} sub={t.asset.rrNet} hint={t.glossary.riskReward} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={t.signals.detailWhy} subtitle={reasons.summary}>
          <ul className="space-y-1.5">
            {reasons.rules.map((r) => (
              <li key={r.id} className="flex gap-2 text-2xs">
                <span
                  className={`mt-px shrink-0 rounded px-1 py-px font-semibold ${
                    r.skipped ? 'bg-bg-inset text-ink-faint' : r.passed ? 'bg-up-dim text-up' : 'bg-down-dim text-down'
                  }`}
                >
                  {r.skipped ? 'SKIP' : r.passed ? 'PASS' : 'FAIL'}
                </span>
                <span>
                  <span className="text-ink">{r.id}</span>{' '}
                  <span className="text-ink-muted">{r.description}</span>
                  <span className="block text-ink-faint">{r.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-5">
          <Card title={t.signals.detailRisks}>
            <ul className="space-y-1 text-2xs text-ink-muted">
              {risks.map((r, i) => (
                <li key={i}>• {r}</li>
              ))}
              {risks.length === 0 && <li className="text-ink-faint">{t.signals.noneRecorded}</li>}
            </ul>
          </Card>

          <Card title={t.signals.detailInvalidation} subtitle={t.glossary.invalidation}>
            <ul className="space-y-1 text-2xs text-ink-muted">
              {invalidation.map((r, i) => (
                <li key={i}>• {r}</li>
              ))}
              {invalidation.length === 0 && <li className="text-ink-faint">{t.signals.noneRecorded}</li>}
            </ul>
          </Card>
        </div>
      </div>

      <Card
        title={t.signals.boughtThisTitle}
        subtitle={t.signals.boughtThisSub}
      >
        <BuyFromSignal
          t={formLabels}
          assets={assetOptions}
          prefill={{
            assetId: signal.asset_id,
            entryPrice: signal.price_at_signal,
            stopLoss: signal.stop_loss ?? undefined,
            takeProfit1: signal.take_profit_1 ?? undefined,
            takeProfit2: signal.take_profit_2 ?? undefined,
            timeframe: signal.timeframe,
            tradingStyle: signal.trading_style,
            signalId: signal.id,
          }}
        />
      </Card>

      <Card title={t.signals.sizing} subtitle={t.signals.sizingSub}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={t.signals.positionSize} value={formatNumber(signal.position_size, 6)} sub={t.signals.units} hint={t.glossary.positionSize} />
          <Stat label={t.signals.riskAmount} value={formatNumber(signal.risk_amount, 2)} sub={signal.currency} />
          <Stat label={t.signals.dataQuality} value={signal.data_quality} hint={t.glossary.dataQuality} />
          <Stat label={t.common.regime} value={signal.regime.replace(/_/g, ' ')} hint={t.glossary.regime} />
        </div>
      </Card>

      <Card title={t.signals.indicatorSnapshot} subtitle={t.signals.indicatorSnapshotSub}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 lg:grid-cols-4">
          {Object.entries(indicators)
            .filter(([, v]) => typeof v === 'number' || typeof v === 'boolean' || v === null)
            .map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 border-b border-line/50 py-1 text-2xs">
                <span className="text-ink-faint">{k}</span>
                <span className="num text-ink-muted">
                  {v === null ? '—' : typeof v === 'number' ? formatIndicator(v) : String(v)}
                </span>
              </div>
            ))}
        </div>
      </Card>

      <Card title={t.signals.forwardEval} subtitle={t.signals.forwardEvalSub}>
        {!evaluation ? (
          <p className="text-2xs text-ink-faint">
            {t.signals.notEvaluated}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t.signals.outcome} value={evaluation.outcome.replace(/_/g, ' ')} hint={t.glossary.forwardEval} />
              <Stat label={t.signals.netReturn} value={formatPercentSigned(evaluation.return_pct_net)} />
              <Stat label={t.signals.rMultiple} value={formatNumber(evaluation.r_multiple, 2)} hint={t.glossary.rMultiple} />
              <Stat label={t.signals.barsObserved} value={evaluation.bars_observed} />
            </div>
            <p className="mt-3 text-2xs text-ink-muted">{evaluation.exit_reason}</p>
            <p className="mt-1 text-2xs text-ink-faint">
              {t.signals.excursionNote(
                formatPercent(evaluation.max_favorable_excursion),
                formatPercent(evaluation.max_adverse_excursion),
                evaluation.fee_assumption_bps,
                evaluation.slippage_assumption_bps,
              )}
              {evaluation.overlaps_prior === 1 && t.signals.overlapNote}
            </p>
          </>
        )}
      </Card>

      <InfoNote>
        {t.signals.lineage(
          formatUtc(signal.generated_at_ms),
          formatUtc(signal.candle_open_ms),
          formatUtc(signal.data_fetched_ms),
        )}{' '}
        <Link href="/signals" className="text-accent hover:underline">
          {t.signals.backToSignals}
        </Link>
      </InfoNote>
    </div>
  );
}
