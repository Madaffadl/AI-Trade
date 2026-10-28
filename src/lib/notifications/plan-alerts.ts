import { formatIdr, formatIdrSigned, formatWib } from '@/lib/format';
import type { Messages } from '@/lib/i18n';
import { TIMEFRAME_MS } from '@/lib/market/types';
import { actionLine, pairLabel, stateLabel, timeframeLabel } from '@/lib/plan/labels';
import { isTerminal } from '@/lib/plan/states';
import { ENTRY_WINDOW_BARS, type SetupState, type StateReason, type TradePlan, type ValidationLabel } from '@/lib/plan/types';
import type { SimEvent } from '@/lib/sim/fills';
import type { NewAlert } from './repo';

/**
 * The alerts the app raises about plans, paper trades and your holdings.
 * Pure: each builder turns a state into an alert (or nothing); creating and
 * de-duplicating it is dispatch.ts's job.
 *
 * A dedupe key names the EVENT, so re-checking an unchanged state every minute
 * never repeats an alert:
 *   setup:<id>:BUY_NOW                  a setup became buyable (once per setup)
 *   watch:<pair>:<strategy>:<tf>:<n>    one trigger away; a pending setup is
 *                                       re-created every candle, so this is
 *                                       bucketed to once per entry window
 *   setup:<id>:<terminal state>         a setup that WAS buyable no longer is
 *   sim:<id>:fill:<n> / sim:<id>:expired  a paper trade filled, sold, expired
 *   position_live_stop|tp1:<id>, position_time:<id>   your holding needs action
 */

type T = Messages;

export interface SetupForAlert {
  id: string;
  asset_id: string;
  state: SetupState;
  state_reason: StateReason;
  validation: ValidationLabel;
  signal_id: string | null;
  plan: TradePlan;
}

export const buyNowKey = (setupId: string) => `setup:${setupId}:BUY_NOW`;

function planLines(t: T, plan: TradePlan): string[] {
  return [
    t.notify.levelsLine(
      formatIdr(plan.entry.planned),
      formatIdr(plan.entry.max),
      formatIdr(plan.stopLoss),
      plan.outcome.stopDistancePercent.toFixed(2),
      formatIdr(plan.takeProfit1),
      plan.outcome.tp1DistancePercent.toFixed(2),
    ),
    t.notify.sizeLine(formatIdr(plan.sizing.notionalIdr), formatIdr(plan.sizing.lossAtStopIdr), formatIdr(plan.outcome.netProfitTp1Idr)),
    t.notify.holdLine(Math.round(plan.holding.horizonMs / 3_600_000), formatWib(plan.expiresAtMs)),
  ];
}

/** BUY NOW, or one trigger away from it. Null for every other state. */
export function setupAlert(t: T, s: SetupForAlert): NewAlert | null {
  const pair = pairLabel(s.plan);
  const tf = timeframeLabel(t, s.plan.timeframe);
  const experimental = s.validation !== 'validated';
  const body = (lead: string | null) =>
    [lead, ...planLines(t, s.plan), experimental ? t.notify.experimentalLine : null].filter(Boolean).join('\n');

  if (s.state === 'BUY_NOW') {
    return {
      dedupeKey: buyNowKey(s.id),
      kind: 'setup',
      // An unvalidated strategy is information, not a call to act with real money.
      severity: experimental ? 'info' : 'warning',
      title: experimental ? t.notify.buyNowExperimentalTitle(pair, tf) : t.notify.buyNowTitle(pair, tf),
      body: body(actionLine(t, s.plan, s.state, s.state_reason)),
      assetId: s.asset_id,
      signalId: s.signal_id,
      payload: { setupId: s.id },
    };
  }
  if (s.state === 'WAIT_FOR_ENTRY' && s.state_reason === 'awaiting_trigger' && s.plan.trigger) {
    const bucket = Math.floor(s.plan.signalBarOpenMs / (ENTRY_WINDOW_BARS * TIMEFRAME_MS[s.plan.timeframe]));
    return {
      dedupeKey: `watch:${s.asset_id}:${s.plan.strategyId}:${s.plan.timeframe}:${bucket}`,
      kind: 'setup',
      severity: 'info',
      title: t.notify.watchTitle(pair, tf),
      body: body(actionLine(t, s.plan, s.state, s.state_reason)),
      assetId: s.asset_id,
      payload: { setupId: s.id },
    };
  }
  return null;
}

/**
 * A setup that had been announced as buyable has failed, run away, or expired.
 * The caller only asks for this when a BUY NOW alert was actually sent.
 */
export function cancelAlert(t: T, s: SetupForAlert): NewAlert | null {
  if (!isTerminal(s.state)) return null;
  const why =
    s.state_reason === 'below_stop'
      ? t.notify.cancelBelowStop
      : s.state_reason === 'left_trigger_zone'
        ? t.notify.cancelLeftZone
        : s.state_reason === 'target_passed'
          ? t.notify.cancelTargetPassed
          : t.notify.cancelExpired;
  return {
    dedupeKey: `setup:${s.id}:${s.state}`,
    kind: 'setup',
    severity: 'info',
    title: t.notify.cancelTitle(pairLabel(s.plan), timeframeLabel(t, s.plan.timeframe), stateLabel(t, s.state)),
    body: [why, t.notify.cancelHolding].join('\n'),
    assetId: s.asset_id,
    payload: { setupId: s.id },
  };
}

function exitReasonLabel(t: T, reason: string): string {
  if (reason === 'stop') return t.notify.reasonStop;
  if (reason === 'tp1') return t.notify.reasonTp1;
  if (reason === 'time') return t.notify.reasonTime;
  if (reason === 'manual') return t.notify.reasonManual;
  return reason;
}

/** A paper trade filled, sold, or expired without filling. */
export function simAlert(
  t: T,
  trade: { id: string; asset_id: string; plan: Pick<TradePlan, 'description' | 'symbol'> },
  event: SimEvent,
): NewAlert {
  const pair = pairLabel(trade.plan);
  const common = { kind: 'simulation' as const, severity: 'info' as const, assetId: trade.asset_id, payload: { simId: trade.id } };
  if (event.kind === 'expired') {
    return { ...common, dedupeKey: `sim:${trade.id}:expired`, title: t.notify.simCancelledTitle(pair), body: t.notify.simCancelledBody };
  }
  const f = event.fill;
  const dedupeKey = `sim:${trade.id}:fill:${event.index}`;
  if (f.side === 'buy') {
    return {
      ...common,
      dedupeKey,
      title: t.notify.simBoughtTitle(pair),
      body: t.notify.simBoughtBody(formatIdr(f.price), formatIdr(f.price * f.quantity)),
    };
  }
  return {
    ...common,
    dedupeKey,
    title: t.notify.simSoldTitle(pair, exitReasonLabel(t, f.reason)),
    body: t.notify.simSoldBody(formatIdr(f.price), formatIdrSigned(f.pnlIdr ?? 0)),
  };
}

export interface HoldingForAlert {
  id: string;
  asset_id: string;
  symbol: string;
  display_name: string;
  quantity: number;
  entry_price: number;
  entry_fee: number | null;
  stop_loss: number | null;
  take_profit_1: number | null;
  /** From the strategy's holding period; null when recorded without a strategy. */
  sellByMs: number | null;
}

/**
 * A holding you recorded, against the live bid: stop first, then target 1,
 * then the sell-by time. At most one alert, the most urgent. The app never
 * sells for you; the alert says what the plan says to do.
 */
export function holdingAlert(t: T, p: HoldingForAlert, bid: number, now: number): NewAlert | null {
  const pair = p.display_name || p.symbol;
  const pnl = formatIdrSigned((bid - p.entry_price) * p.quantity - (p.entry_fee ?? 0));
  const common = { kind: 'position' as const, assetId: p.asset_id, payload: { positionId: p.id } };
  if (p.stop_loss !== null && bid <= p.stop_loss) {
    return {
      ...common,
      dedupeKey: `position_live_stop:${p.id}`,
      severity: 'critical',
      title: t.notify.posStopTitle(pair),
      body: t.notify.posStopBody(formatIdr(bid), formatIdr(p.stop_loss), pnl),
    };
  }
  if (p.take_profit_1 !== null && bid >= p.take_profit_1) {
    return {
      ...common,
      dedupeKey: `position_live_tp1:${p.id}`,
      severity: 'warning',
      title: t.notify.posTargetTitle(pair),
      body: t.notify.posTargetBody(formatIdr(bid), formatIdr(p.take_profit_1), pnl),
    };
  }
  if (p.sellByMs !== null && now >= p.sellByMs) {
    return {
      ...common,
      dedupeKey: `position_time:${p.id}`,
      severity: 'warning',
      title: t.notify.posTimeTitle(pair),
      body: t.notify.posTimeBody(formatIdr(bid), pnl),
    };
  }
  return null;
}
