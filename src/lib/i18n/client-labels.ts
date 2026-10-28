import type { Messages } from './en';

/**
 * Plain-string label bags for Client Components.
 *
 * React cannot serialise functions across the server/client boundary, so the
 * full `Messages` object (which contains interpolation functions) must never be
 * passed to a client component. These builders run on the server and return
 * strings only.
 *
 * Messages that need a runtime value are pre-rendered as TEMPLATES containing a
 * `{token}`, which the client substitutes with `fill()`. That keeps one
 * dictionary as the single source of truth instead of duplicating wording.
 */

/** Replace `{token}` placeholders in a template. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

export interface PositionFormLabels {
  open: string;
  asset: string;
  venue: string;
  quantity: string;
  /** Template with `{currency}`. */
  entryPriceTemplate: string;
  buyDate: string;
  fee: string;
  feePlaceholder: string;
  planTimeframe: string;
  tradingStyle: string;
  stopLoss: string;
  stopLossPlaceholder: string;
  target1: string;
  target1Placeholder: string;
  target2: string;
  notes: string;
  notesPlaceholder: string;
  capital: string;
  riskIfStopped: string;
  profitAtTarget: string;
  submit: string;
  saved: string;
  saveFailed: string;
  disclaimer: string;
  closeOpen: string;
  /** Template with `{symbol}`. */
  closeTitleTemplate: string;
  /** Template with `{currency}`. */
  exitPriceTemplate: string;
  exitReason: string;
  exitReasonPlaceholder: string;
  closeSubmit: string;
  closeFailed: string;
  saving: string;
  cancel: string;
  networkError: string;
  venueIndodax: string;
  venuePluang: string;
  venueStockbit: string;
  venueOther: string;
}

export function positionFormLabels(t: Messages): PositionFormLabels {
  return {
    open: t.positionForm.open,
    asset: t.positionForm.asset,
    venue: t.positionForm.venue,
    quantity: t.positionForm.quantity,
    entryPriceTemplate: t.positionForm.entryPrice('{currency}'),
    buyDate: t.positionForm.buyDate,
    fee: t.positionForm.fee,
    feePlaceholder: t.positionForm.feePlaceholder,
    planTimeframe: t.positionForm.planTimeframe,
    tradingStyle: t.positionForm.tradingStyle,
    stopLoss: t.positionForm.stopLoss,
    stopLossPlaceholder: t.positionForm.stopLossPlaceholder,
    target1: t.positionForm.target1,
    target1Placeholder: t.positionForm.target1Placeholder,
    target2: t.positionForm.target2,
    notes: t.positionForm.notes,
    notesPlaceholder: t.positionForm.notesPlaceholder,
    capital: t.positionForm.capital,
    riskIfStopped: t.positionForm.riskIfStopped,
    profitAtTarget: t.positionForm.profitAtTarget,
    submit: t.positionForm.submit,
    saved: t.positionForm.saved,
    saveFailed: t.positionForm.saveFailed,
    disclaimer: t.positionForm.disclaimer,
    closeOpen: t.positionForm.closeOpen,
    closeTitleTemplate: t.positionForm.closeTitle('{symbol}'),
    exitPriceTemplate: t.positionForm.exitPrice('{currency}'),
    exitReason: t.positionForm.exitReason,
    exitReasonPlaceholder: t.positionForm.exitReasonPlaceholder,
    closeSubmit: t.positionForm.closeSubmit,
    closeFailed: t.positionForm.closeFailed,
    saving: t.common.saving,
    cancel: t.common.cancel,
    networkError: t.common.networkError,
    venueIndodax: t.venue.indodax,
    venuePluang: t.venue.pluang,
    venueStockbit: t.venue.stockbit,
    venueOther: t.venue.other,
  };
}

export interface AiPanelLabels {
  generate: string;
  generating: string;
  regenerate: string;
  /** Template with `{status}`. */
  statusTemplate: string;
  noCommentary: string;
  technicalSummary: string;
  bullish: string;
  bearish: string;
  newsContext: string;
  assumptions: string;
  catalysts: string;
  whatInvalidates: string;
  finalAssessment: string;
  limitations: string;
  sources: string;
  sourcesNote: string;
  noneItem: string;
  aiNotConfigured: string;
  callsProvider: string;
  requestFailed: string;
  networkError: string;
}

export function aiPanelLabels(t: Messages): AiPanelLabels {
  return {
    generate: t.ai.generate,
    generating: t.ai.generating,
    regenerate: t.ai.regenerate,
    statusTemplate: t.ai.statusLabel('{status}'),
    noCommentary: t.ai.noCommentary,
    technicalSummary: t.ai.technicalSummary,
    bullish: t.ai.bullish,
    bearish: t.ai.bearish,
    newsContext: t.ai.newsContext,
    assumptions: t.ai.assumptions,
    catalysts: t.ai.catalysts,
    whatInvalidates: t.ai.whatInvalidates,
    finalAssessment: t.ai.finalAssessment,
    limitations: t.ai.limitations,
    sources: t.ai.sources,
    sourcesNote: t.ai.sourcesNote,
    noneItem: t.ai.noneItem,
    aiNotConfigured: t.ai.aiNotConfigured,
    callsProvider: t.ai.callsProvider,
    requestFailed: t.ai.requestFailed,
    networkError: t.common.networkError,
  };
}

/** Labels for the "Simulate this plan" button. */
export function simulateLabels(t: Messages): import('@/components/plan/simulate-button').SimulateLabels {
  return {
    simulate: t.sim.simulate,
    simulating: t.sim.simulating,
    started: t.sim.simStarted,
    pending: t.sim.simPending,
    viewSims: t.sim.viewSims,
    failed: t.sim.actionFailed,
    errors: {
      not_actionable: t.sim.errNotActionable,
      already_simulating: t.sim.errAlready,
      max_positions: t.sim.errMax,
      too_small: t.sim.errSmall,
      daily_stop: t.sim.errDaily,
    },
  };
}
