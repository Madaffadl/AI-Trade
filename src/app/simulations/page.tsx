import Link from 'next/link';
import { Card, EmptyState, InfoNote, Stat, Table, WarningNote } from '@/components/ui';
import { strategyLabel, timeframeLabel } from '@/components/plan/plan-view';
import { TradeTabs } from '@/components/plan/trade-tabs';
import { nowMs } from '@/lib/db/repo';
import { formatIdr, formatIdrSigned, formatPercentSigned, formatQuantity, formatWib } from '@/lib/format';
import { getMessages, type Messages } from '@/lib/i18n';
import { getTradingSettings } from '@/lib/settings/trading';
import { realizedPnlPercent, unrealizedPnl } from '@/lib/sim/fills';
import { listSimTrades, stateOf, type SimTrade } from '@/lib/sim/repo';
import { simAccount, simMetrics } from '@/lib/sim/service';
import { SimActions } from './sim-actions';

export const dynamic = 'force-dynamic';

/**
 * Paper trading. Reads only what the refresh cycle stored - marks, fills and
 * results - and never calls the exchange while rendering.
 */
export default async function SimulationsPage() {
  const t = await getMessages();
  const now = nowMs();
  const [trades, settings] = await Promise.all([listSimTrades(), getTradingSettings()]);
  const account = await simAccount(trades, settings, now);
  const metrics = simMetrics(trades);
  const active = trades.filter((x) => x.status === 'open' || x.status === 'pending_entry');
  const finished = trades.filter((x) => x.status === 'closed' || x.status === 'cancelled');

  return (
    <div className="space-y-5">
      <TradeTabs active="sim" labels={{ sim: t.sim.tabSim, real: t.sim.tabReal }} />
      <div>
        <h1 className="text-lg font-semibold text-ink">{t.sim.title}</h1>
        <p className="mt-0.5 text-2xs text-ink-muted">{t.sim.subtitle}</p>
        <p className="mt-0.5 text-2xs text-ink-faint">
          {settings.autoSimulate ? t.sim.autoOn : t.sim.autoOff} {t.sim.refreshNote}{' '}
          <Link href="/settings#trading" className="text-accent hover:underline">
            {t.plan.settingsLink}
          </Link>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label={t.sim.startCapital} value={formatIdr(account.startCapitalIdr)} />
        <Stat label={t.sim.equity} value={formatIdr(account.equityIdr)} />
        <Stat label={t.sim.realized} value={formatIdrSigned(account.realizedIdr)} tone={tone(account.realizedIdr)} />
        <Stat label={t.sim.unrealized} value={formatIdrSigned(account.unrealizedIdr)} tone={tone(account.unrealizedIdr)} />
        <Stat
          label={t.sim.winRate}
          value={metrics.winRatePct === null ? '—' : `${metrics.winRatePct.toFixed(0)}%`}
          sub={t.sim.closedTrades(metrics.trades)}
        />
        <Stat label={t.sim.profitFactor} value={metrics.profitFactor === null ? '—' : metrics.profitFactor.toFixed(2)} />
      </div>
      {metrics.trades < 30 && <WarningNote>{t.sim.sampleWarning(metrics.trades)}</WarningNote>}

      <Card title={t.sim.activeTitle}>
        {active.length === 0 ? (
          <EmptyState title={t.sim.activeTitle} body={t.sim.activeEmpty} />
        ) : (
          <Table
            caption={t.sim.activeTitle}
            head={[t.sim.colPair, t.sim.colStatus, t.sim.colEntry, t.sim.colStop, t.sim.colTarget, t.sim.colMark, t.sim.colPnl, t.sim.colSellBy, '']}
          >
            {active.map((x) => (
              <ActiveRow key={x.id} x={x} t={t} />
            ))}
          </Table>
        )}
      </Card>

      <Card title={t.sim.journalTitle}>
        {finished.length === 0 ? (
          <p className="text-2xs text-ink-faint">{t.sim.journalEmpty}</p>
        ) : (
          <Table
            caption={t.sim.journalTitle}
            head={[t.sim.colPair, t.sim.colPlanned, t.sim.colEntry, t.sim.colExit, t.sim.colReason, t.sim.colPnl, t.sim.colHeld]}
          >
            {finished.map((x) => (
              <JournalRow key={x.id} x={x} t={t} />
            ))}
          </Table>
        )}
      </Card>

      <Card title={t.sim.assumptionsTitle}>
        <p className="text-2xs leading-relaxed text-ink-muted">{t.sim.assumptionsBody}</p>
      </Card>
      <InfoNote>{t.plan.riskWarning}</InfoNote>
    </div>
  );
}

function tone(v: number): string {
  return v > 0 ? 'text-up' : v < 0 ? 'text-down' : '';
}

function pairCell(x: SimTrade, t: Messages) {
  return (
    <td className="px-2 py-2 text-xs">
      <span className="font-medium text-ink">{x.plan.description || x.symbol}</span>
      <span className="block text-2xs text-ink-faint">
        {timeframeLabel(t, x.timeframe)} · {strategyLabel(t, x.strategy_id)} · {x.mode === 'auto' ? t.sim.modeAuto : t.sim.modeManual}
      </span>
    </td>
  );
}

function ActiveRow({ x, t }: { x: SimTrade; t: Messages }) {
  const s = stateOf(x);
  const pnl = x.mark_price === null ? null : unrealizedPnl(s, x.mark_price, x.costs);
  const kind = x.entry_kind === 'market' ? t.sim.kindMarket : x.entry_kind === 'limit' ? t.sim.kindLimit : t.sim.kindTrigger;
  return (
    <tr>
      {pairCell(x, t)}
      <td className="px-2 py-2 text-2xs">
        <span className={x.status === 'open' ? 'font-semibold text-up' : 'font-semibold text-accent'}>
          {x.status === 'open' ? t.sim.statusOpen : t.sim.statusPending}
        </span>
        <span className="block text-ink-faint">{kind}</span>
      </td>
      <td className="num px-2 py-2 text-xs">
        {x.entry_price === null ? `≤ ${formatIdr(x.entry_max)}` : formatIdr(x.entry_price)}
        {x.quantity ? <span className="block text-2xs text-ink-faint">{formatQuantity(x.quantity)}</span> : null}
      </td>
      <td className="num px-2 py-2 text-xs text-down">{formatIdr(x.stop_loss)}</td>
      <td className="num px-2 py-2 text-xs text-up">{formatIdr(x.take_profit_1)}</td>
      <td className="num px-2 py-2 text-xs">{formatIdr(x.mark_price)}</td>
      <td className={`num px-2 py-2 text-xs ${pnl === null ? '' : tone(pnl)}`}>{formatIdrSigned(pnl)}</td>
      <td className="px-2 py-2 text-2xs text-ink-muted">{x.sell_by_ms ? formatWib(x.sell_by_ms) : formatWib(x.expires_at_ms)}</td>
      <td className="px-2 py-2">
        <SimActions
          id={x.id}
          status={x.status}
          labels={{ closeAll: t.sim.closeAll, closeHalf: t.sim.closeHalf, cancel: t.sim.cancel, working: t.sim.working, failed: t.sim.actionFailed }}
        />
      </td>
    </tr>
  );
}

function JournalRow({ x, t }: { x: SimTrade; t: Messages }) {
  const reason: Record<string, string> = {
    stop: t.sim.exitStop,
    tp1: t.sim.exitTp1,
    time: t.sim.exitTime,
    manual: t.sim.exitManual,
    expired: t.sim.exitExpired,
    cancelled: t.sim.exitCancelled,
  };
  const pct = realizedPnlPercent(stateOf(x), x.costs);
  const heldH = x.entry_at_ms && x.exit_at_ms ? Math.round((x.exit_at_ms - x.entry_at_ms) / 3_600_000) : null;
  return (
    <tr>
      {pairCell(x, t)}
      <td className="num px-2 py-2 text-xs text-ink-muted">{formatIdr(x.plan.entry.planned)}</td>
      <td className="num px-2 py-2 text-xs">{formatIdr(x.entry_price)}</td>
      <td className="num px-2 py-2 text-xs">{formatIdr(x.exit_price)}</td>
      <td className="px-2 py-2 text-2xs text-ink-muted">{x.exit_reason ? reason[x.exit_reason] : '—'}</td>
      <td className={`num px-2 py-2 text-xs ${tone(x.realized_pnl_idr)}`}>
        {x.entry_price === null ? '—' : formatIdrSigned(x.realized_pnl_idr)}
        {pct !== null && <span className="block text-2xs">{formatPercentSigned(pct)}</span>}
      </td>
      <td className="px-2 py-2 text-2xs text-ink-muted">{heldH === null ? '—' : t.sim.hours(heldH)}</td>
    </tr>
  );
}
