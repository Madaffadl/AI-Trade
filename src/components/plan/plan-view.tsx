import { Stat } from '@/components/ui';
import { formatIdr, formatIdrSigned, formatPercentSigned, formatQuantity, formatWib } from '@/lib/format';
import type { Messages } from '@/lib/i18n';
import type { SetupState, TradePlan, ValidationLabel } from '@/lib/plan/types';

/**
 * Presentation of a trading plan. Server-safe (no client hooks): every number
 * shown here was computed by the plan engine; these components only format
 * and label it.
 */

type T = Messages;

import { actionLine, failureText, pairLabel, stateLabel, strategyLabel, timeframeLabel } from '@/lib/plan/labels';

export { actionLine, failureText, pairLabel, stateLabel, strategyLabel, timeframeLabel };

const STATE_STYLE: Record<SetupState, string> = {
  BUY_NOW: 'bg-up-dim text-up border-up/40',
  WAIT_FOR_ENTRY: 'bg-accent-dim text-accent border-accent/40',
  NOT_ELIGIBLE: 'bg-bg-inset text-ink-muted border-line-strong',
  MISSED: 'bg-bg-inset text-ink-muted border-line-strong',
  INVALIDATED: 'bg-down-dim text-down border-down/40',
  EXPIRED: 'bg-bg-inset text-ink-muted border-line-strong',
  DATA_STALE: 'bg-warn-dim text-warn border-warn/40',
};

/** State as a word in a coloured box - the word carries the meaning, the colour only reinforces it. */
export function StateBadge({ state, t }: { state: SetupState; t: T }) {
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-2xs font-bold tracking-wide ${STATE_STYLE[state]}`}>
      {stateLabel(t, state)}
    </span>
  );
}

export function ValidationNote({ validation, t }: { validation: ValidationLabel; t: T }) {
  if (validation === 'validated') {
    return <p className="text-2xs font-semibold text-up">{t.plan.validated}</p>;
  }
  return (
    <p className="text-2xs text-warn">
      <span className="font-semibold">{t.plan.experimental}.</span> {t.plan.experimentalBody}
    </p>
  );
}

/** The numbers of a plan, in the order a trader acts on them. */
export function PlanFacts({ plan, t, now }: { plan: TradePlan; t: T; now: number }) {
  const s = plan.sizing;
  const limit = s.limitedBy === 'risk' ? t.plan.limitRisk : s.limitedBy === 'allocation' ? t.plan.limitAllocation : t.plan.limitCash;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label={t.plan.entry} value={formatIdr(plan.entry.planned)} sub={`${t.plan.maxEntry} ${formatIdr(plan.entry.max)}`} />
        <Stat
          label={t.plan.stopLoss}
          value={formatIdr(plan.stopLoss)}
          sub={formatPercentSigned(-plan.outcome.stopDistancePercent)}
          tone="text-down"
        />
        <Stat
          label={t.plan.target1}
          value={formatIdr(plan.takeProfit1)}
          sub={formatPercentSigned(plan.outcome.tp1DistancePercent)}
          tone="text-up"
        />
        {plan.takeProfit2 !== null && (
          <Stat
            label={t.plan.target2}
            value={formatIdr(plan.takeProfit2)}
            sub={formatPercentSigned(((plan.takeProfit2 - plan.entry.planned) / plan.entry.planned) * 100)}
            tone="text-up"
          />
        )}
        <Stat label={t.plan.amount} value={formatIdr(s.notionalIdr)} sub={`${formatQuantity(s.quantity)} ${plan.symbol.replace(/IDR$/, '')}`} />
        <Stat label={t.plan.maxLoss} value={formatIdrSigned(-s.lossAtStopIdr)} tone="text-down" />
        <Stat label={t.plan.netProfitTp1} value={formatIdrSigned(plan.outcome.netProfitTp1Idr)} tone="text-up" />
        {plan.outcome.netProfitTp2Idr !== null && (
          <Stat label={t.plan.netProfitTp2} value={formatIdrSigned(plan.outcome.netProfitTp2Idr)} tone="text-up" />
        )}
        <Stat label={t.plan.riskReward} value={`1 : ${plan.outcome.netRiskReward.toFixed(2)}`} />
        <Stat label={t.plan.costs} value={`${plan.costs.roundTripPercent.toFixed(2)}%`} />
        <Stat
          label={t.plan.sellBy}
          value={t.plan.hours(Math.round(plan.holding.horizonMs / 3_600_000))}
          sub={t.plan.sellByValue(Math.round(plan.holding.horizonMs / 3_600_000), formatWib(now + plan.holding.horizonMs))}
        />
        <Stat label={t.plan.validUntil} value={formatWib(plan.expiresAtMs)} />
      </div>
      <p className="text-2xs text-ink-muted">{t.plan.sizingNote(limit, s.effectiveRiskPercent.toFixed(2))}</p>
    </div>
  );
}

/** The optional "why" - rules, trend context, risks, invalidation. Collapsed by default. */
export function WhySection({ plan, t, open = false }: { plan: TradePlan; t: T; open?: boolean }) {
  return (
    <details open={open} className="rounded border border-line bg-bg-inset px-3 py-2">
      <summary className="cursor-pointer text-xs font-semibold text-ink">{t.plan.whyTitle}</summary>
      <div className="mt-3 space-y-3 text-2xs">
        <p className={plan.context.up ? 'text-up' : 'text-down'}>
          {plan.context.up ? '▲' : '▼'} {t.plan.contextLine(timeframeLabel(t, plan.contextTimeframe), plan.context.up)}
        </p>
        {plan.rules.length > 0 && (
          <div>
            <h3 className="mb-1 font-semibold uppercase tracking-wide text-ink-faint">{t.plan.rulesTitle}</h3>
            <ul className="space-y-1">
              {plan.rules.map((r) => (
                <li key={r.id} className="flex gap-2">
                  <span className={`w-10 shrink-0 font-semibold ${r.skipped ? 'text-ink-faint' : r.passed ? 'text-up' : 'text-down'}`}>
                    {r.skipped ? 'SKIP' : r.passed ? 'PASS' : 'FAIL'}
                  </span>
                  <span className="text-ink-muted">
                    {r.description} — <span className="num">{r.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {plan.risks.length > 0 && (
          <div>
            <h3 className="mb-1 font-semibold uppercase tracking-wide text-ink-faint">{t.plan.risksTitle}</h3>
            <ul className="list-disc space-y-1 pl-4 text-ink-muted">
              {plan.risks.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        {plan.invalidation.length > 0 && (
          <div>
            <h3 className="mb-1 font-semibold uppercase tracking-wide text-ink-faint">{t.plan.invalidationTitle}</h3>
            <ul className="list-disc space-y-1 pl-4 text-ink-muted">
              {plan.invalidation.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}
