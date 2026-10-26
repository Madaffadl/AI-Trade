import { listAssets } from '@/lib/db/repo';
import { directionGlyph, formatAge, formatNumber, formatPercentSigned, formatUtc } from '@/lib/format';
import { buildPositionPlan, summarizePortfolio, type PositionPlan } from '@/lib/positions/plan';
import { listPositions } from '@/lib/positions/repo';
import { getMessages } from '@/lib/i18n';
import { positionFormLabels, type PositionFormLabels } from '@/lib/i18n/client-labels';
import type { Messages } from '@/lib/i18n/en';
import { ActionBadge, Card, DataQualityBadge, EmptyState, InfoNote, Stat, Table, WarningNote } from '@/components/ui';
import { FxDisclosure, Money } from '@/components/money';
import { Hint, HintMark } from '@/components/hint';
import { actionHint } from '@/components/scan-table';
import { convertForDisplay, fxContext, getDisplayCurrencySetting, type FxContext } from '@/lib/fx/service';
import { ClosePositionForm, RecordBuyForm } from './position-forms';

export const dynamic = 'force-dynamic';

export default async function PortfolioPage() {
  const [open, closed, assets] = await Promise.all([
    listPositions('open'),
    listPositions('closed'),
    listAssets(),
  ]);

  const t = await getMessages();
  const formLabels = positionFormLabels(t);
  const display = await getDisplayCurrencySetting();
  const fx = await fxContext(display);
  const plans = await Promise.all(open.map((p) => buildPositionPlan(p)));
  const summary = summarizePortfolio(plans);
  const byId = new Map(plans.map((p) => [p.positionId, p]));

  const assetOptions = assets.map((a) => ({
    id: a.id,
    symbol: a.symbol,
    displayName: a.displayName,
    exchangeId: a.exchangeId,
    currency: a.currency,
  }));

  const needAction = plans.filter((p) => p.action === 'SELL');
  const currencies = [...new Set(open.map((p) => p.currency))];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink">{t.portfolio.title}</h1>
        <p className="text-2xs text-ink-muted">{t.portfolio.subtitle}</p>
      </div>

      {needAction.length > 0 && (
        <WarningNote>
          {t.portfolio.needActionBanner(needAction.length, needAction.map((p) => p.symbol).join(', '))}
        </WarningNote>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t.portfolio.statOpen} value={summary.openCount} hint={t.glossary.venue} />
        <Stat label={t.portfolio.statSell} value={summary.actionsNeeded} tone={summary.actionsNeeded > 0 ? 'text-down' : ''} />
        <Stat label={t.portfolio.statStop} value={summary.stopsBreached} tone={summary.stopsBreached > 0 ? 'text-down' : ''} />
        <Stat label={t.portfolio.statClosed} value={closed.length} sub={t.portfolio.statClosedSub} />
      </div>

      {currencies.length > 0 && (
        <Card title={t.portfolio.valueByCurrency} subtitle={t.portfolio.valueByCurrencySub}>
          <div className="grid gap-3 sm:grid-cols-3">
            {currencies.map((c) => {
              const unrealized = summary.totalUnrealized[c] ?? null;
              return (
                <div key={c} className="rounded border border-line bg-bg-inset px-3 py-2">
                  <p className="text-2xs uppercase tracking-wide text-ink-faint">{c}</p>
                  <p className="num mt-1 text-sm text-ink">
                    {t.portfolio.cost} {formatNumber(summary.totalCostBasis[c] ?? null, 0)}
                  </p>
                  <p className="num text-sm text-ink-muted">
                    {t.portfolio.currentValue} {formatNumber(summary.totalMarketValue[c] ?? null, 0)}
                  </p>
                  <p className={`num text-sm font-semibold ${(unrealized ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>
                    {unrealized === null ? '—' : `${unrealized >= 0 ? '+' : ''}${formatNumber(unrealized, 0)}`}
                  </p>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card
        title={t.portfolio.recordBuy}
        subtitle={t.portfolio.recordBuySub}
      >
        {assetOptions.length === 0 ? (
          <EmptyState title={t.portfolio.noAssets} body={t.portfolio.noAssetsBody} />
        ) : (
          <RecordBuyForm assets={assetOptions} t={formLabels} />
        )}
      </Card>

      <Card title={t.portfolio.openPositions(open.length)}>
        {open.length === 0 ? (
          <EmptyState
            title={t.portfolio.noPositions}
            body={t.portfolio.noPositionsBody}
          />
        ) : (
          <div className="space-y-4">
            {open.map((p) => {
              const plan = byId.get(p.id);
              if (!plan) return null;
              return (
                <PositionCard
                  key={p.id}
                  plan={plan}
                  venueLabel={t.venue[p.venue as keyof typeof t.venue] ?? p.venue}
                  entryAtMs={p.entry_at_ms}
                  notes={p.notes}
                  fx={fx}
                  t={t}
                  formLabels={formLabels}
                />
              );
            })}
          </div>
        )}
      </Card>

      <Card title={t.portfolio.closedHistory(closed.length)} subtitle={t.portfolio.closedHistorySub}>
        {closed.length === 0 ? (
          <EmptyState title={t.portfolio.noHistory} body={t.portfolio.noHistoryBody} />
        ) : (
          <Table
            head={[
              t.common.asset,
              t.portfolio.app,
              t.common.quantity,
              t.portfolio.buy,
              t.portfolio.sell,
              t.portfolio.duration,
              t.portfolio.result,
              '%',
              t.common.reason,
            ]}
          >
            {closed.map((p) => (
              <tr key={p.id}>
                <td className="px-2 py-2 text-xs text-ink">
                  {p.symbol}
                  <span className="ml-1 text-2xs text-ink-faint">{p.exchange_id}</span>
                </td>
                <td className="px-2 py-2 text-2xs text-ink-muted">{t.venue[p.venue as keyof typeof t.venue] ?? p.venue}</td>
                <td className="num px-2 py-2 text-ink-muted">{formatNumber(p.quantity, 6)}</td>
                <td className="px-2 py-2 text-ink-muted">
                  <Money money={convertForDisplay(p.entry_price, p.currency, fx)} />
                </td>
                <td className="px-2 py-2 text-ink-muted">
                  <Money money={convertForDisplay(p.exit_price, p.currency, fx)} />
                </td>
                <td className="px-2 py-2 text-2xs text-ink-faint">
                  {p.exit_at_ms ? t.portfolio.days(Math.round((p.exit_at_ms - p.entry_at_ms) / 86_400_000)) : '—'}
                </td>
                <td className={`num px-2 py-2 ${(p.realized_pnl ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>
                  {formatNumber(p.realized_pnl, 0)}
                </td>
                <td className={`num whitespace-nowrap px-2 py-2 ${(p.realized_pnl_pct ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>
                  {formatPercentSigned(p.realized_pnl_pct)}
                </td>
                <td className="px-2 py-2 text-2xs text-ink-faint">{p.exit_reason ?? '—'}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <FxDisclosure target={display} providerUpdatedAtMs={fx.rates?.providerUpdatedAtMs ?? null} />

      <InfoNote>{t.portfolio.footer}</InfoNote>
    </div>
  );
}

function PositionCard({
  plan,
  venueLabel,
  entryAtMs,
  notes,
  fx,
  t,
  formLabels,
}: {
  plan: PositionPlan;
  venueLabel: string;
  entryAtMs: number;
  notes: string | null;
  fx: FxContext;
  t: Messages;
  formLabels: PositionFormLabels;
}) {
  const pnlTone = (plan.unrealizedPnl ?? 0) >= 0 ? 'text-up' : 'text-down';
  const progress = plan.progressToTp1 === null ? null : Math.max(0, Math.min(1, plan.progressToTp1));

  return (
    <div className="rounded border border-line bg-bg-inset p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">{plan.symbol}</span>
        <span className="rounded border border-line-strong px-1.5 py-px text-2xs text-ink-muted">{venueLabel}</span>
        <DataQualityBadge quality={plan.dataQuality} labels={t.quality} />
        <ActionBadge action={plan.action} size="lg" hint={actionHint(t, plan.action)} />
        {plan.stopBreached && (
          <span className="rounded border border-down/40 bg-down-dim px-1.5 py-px text-2xs font-semibold text-down">
            {t.portfolio.stopHit}
          </span>
        )}
        {plan.targetReached && !plan.stopBreached && (
          <span className="rounded border border-up/40 bg-up-dim px-1.5 py-px text-2xs font-semibold text-up">
            {t.portfolio.targetTouched}
          </span>
        )}
        <span className="ml-auto text-2xs text-ink-faint">
          {t.portfolio.boughtAt(formatUtc(entryAtMs), Math.round(plan.holdingDays))}
        </span>
      </div>

      <p className="mt-2 text-xs text-ink-muted">{plan.actionReason}</p>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label={t.common.quantity} value={formatNumber(plan.quantity, 6)} hint={t.glossary.lotSize} />
        <Stat label={t.portfolio.entryPrice} value={<Money money={convertForDisplay(plan.entryPrice, plan.currency, fx)} />} hint={t.glossary.entry} />
        <Stat label={t.portfolio.currentPrice} value={<Money money={convertForDisplay(plan.currentPrice, plan.currency, fx)} />} />
        <Stat label={t.portfolio.cost} value={formatNumber(plan.costBasis, 0)} sub={plan.currency} hint={t.glossary.costBasis} />
        <Stat label={t.portfolio.currentValue} value={formatNumber(plan.marketValue, 0)} sub={plan.currency} />
        <Stat
          label={t.portfolio.pnl}
          hint={t.glossary.unrealizedPnl}
          value={plan.unrealizedPnl === null ? '—' : formatNumber(plan.unrealizedPnl, 0)}
          sub={formatPercentSigned(plan.unrealizedPnlPct)}
          tone={pnlTone}
        />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <LevelBox
          title={t.portfolio.stopLoss}
          hint={t.glossary.stopLoss}
          price={plan.stopLoss}
          currency={plan.currency}
          fx={fx}
          distance={plan.stopDistancePct === null ? null : t.portfolio.belowCurrent(plan.stopDistancePct.toFixed(2))}
          amount={plan.lossIfStopped}
          tone="down"
          t={t}
        />
        <LevelBox
          title={t.portfolio.target1}
          hint={t.glossary.takeProfit}
          price={plan.takeProfit1}
          currency={plan.currency}
          fx={fx}
          distance={plan.tp1DistancePct === null ? null : t.portfolio.toGo(plan.tp1DistancePct.toFixed(2))}
          amount={plan.profitAtTp1}
          tone="up"
          t={t}
        />
        <LevelBox
          title={t.portfolio.target2}
          hint={t.glossary.takeProfit}
          price={plan.takeProfit2}
          currency={plan.currency}
          fx={fx}
          distance={null}
          amount={plan.profitAtTp2}
          tone="up"
          t={t}
        />
      </div>

      {progress !== null && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-2xs text-ink-faint">
            <Hint text={t.glossary.takeProfit}>
              <span>{t.portfolio.progressToTarget}</span>
            </Hint>
            <span className="num">{(progress * 100).toFixed(0)}%</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-bg">
            <div className="h-full rounded bg-up" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      )}

      {plan.rules.length > 0 && (
        /*
         * Open by default when the app is telling you to SELL.
         * The evidence for a real-money action should not be one click away;
         * for HOLD it stays collapsed, because there is nothing to act on.
         */
        <details className="mt-3" open={plan.action === 'SELL'}>
          <summary className="cursor-pointer text-2xs text-accent">{t.portfolio.showRules}</summary>
          <ul className="mt-1.5 space-y-0.5">
            {plan.rules.map((r) => (
              <li key={r.id} className="flex gap-2 text-2xs">
                <span className={`shrink-0 font-semibold ${r.skipped ? 'text-ink-faint' : r.passed ? 'text-up' : 'text-down'}`}>
                  {r.skipped ? t.ui.skip : r.passed ? t.portfolio.yes : t.portfolio.no}
                </span>
                <span className="text-ink-muted">
                  {r.id} {r.description} — <span className="text-ink-faint">{r.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {plan.warnings.map((w, i) => (
        <p key={i} className="mt-1.5 text-2xs text-warn">
          · {w}
        </p>
      ))}

      {notes && <p className="mt-1.5 text-2xs text-ink-faint">{t.portfolio.noteLabel} {notes}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ClosePositionForm
          positionId={plan.positionId}
          symbol={plan.symbol}
          currency={plan.currency}
          suggestedPrice={plan.currentPrice}
          t={formLabels}
        />
        <span className="text-2xs text-ink-faint">
          {t.portfolio.dataAge(plan.dataFetchedAtMs ? formatAge(plan.dataFetchedAtMs) : '—', plan.regime.replace(/_/g, ' '))}
        </span>
      </div>
    </div>
  );
}

function LevelBox({
  title,
  price,
  currency,
  distance,
  amount,
  tone,
  fx,
  t,
  hint,
}: {
  title: string;
  price: number | null;
  currency: string;
  distance: string | null;
  amount: number | null;
  tone: 'up' | 'down';
  fx: FxContext;
  t: Messages;
  hint: string;
}) {
  return (
    <div className="rounded border border-line bg-bg px-3 py-2">
      <p className="text-2xs uppercase tracking-wide text-ink-faint">
        {title}
        <HintMark text={hint} />
      </p>
      <p className={`mt-0.5 text-sm font-semibold ${tone === 'up' ? 'text-up' : 'text-down'}`}>
        {price === null ? t.portfolio.notSet : <Money money={convertForDisplay(price, currency, fx)} />}
      </p>
      {distance && <p className="text-2xs text-ink-muted">{distance}</p>}
      {amount !== null && (
        <p className="num text-2xs text-ink-faint">
          {directionGlyph(amount)} {amount >= 0 ? t.portfolio.profit : t.portfolio.loss}{' '}
          {formatNumber(Math.abs(amount), 0)} {currency}
        </p>
      )}
    </div>
  );
}
