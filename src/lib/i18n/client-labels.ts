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

export interface WatchlistFormLabels {
  market: string;
  searchSymbol: string;
  tradingStyle: string;
  search: string;
  searching: string;
  add: string;
  noResults: string;
  /** Template with `{symbol}`. */
  addedTemplate: string;
  addFailed: string;
  /** Template with `{symbol}`. */
  confirmRemoveTemplate: string;
  remove: string;
  crypto: string;
  stocks: string;
  networkError: string;
}

export function watchlistFormLabels(t: Messages): WatchlistFormLabels {
  return {
    market: t.watchlist.searchMarket,
    searchSymbol: t.watchlist.searchSymbol,
    tradingStyle: t.watchlist.tradingStyle,
    search: t.watchlist.search,
    searching: t.watchlist.searching,
    add: t.watchlist.add,
    noResults: t.watchlist.noResults,
    addedTemplate: t.watchlist.added('{symbol}'),
    addFailed: t.watchlist.addFailed,
    confirmRemoveTemplate: t.watchlist.confirmRemove('{symbol}'),
    remove: t.common.remove,
    crypto: t.common.crypto,
    stocks: t.common.stocks,
    networkError: t.common.networkError,
  };
}

export interface RecommendLabels {
  notAPrediction: string;
  howScored: string;
  howScoredBody: string;
  filterExchange: string;
  filterBand: string;
  allVenues: string;
  anyBand: string;
  bandLiquid: string;
  bandActive: string;
  bandSpeculative: string;
  bandThin: string;
  bandLiquidHelp: string;
  bandActiveHelp: string;
  bandSpeculativeHelp: string;
  bandThinHelp: string;
  colSymbol: string;
  colScore: string;
  colVolume: string;
  colRange: string;
  colChange: string;
  colTrades: string;
  colBand: string;
  colWhy: string;
  scoreHelp: string;
  volumeHelp: string;
  rangeHelp: string;
  tradesHelp: string;
  track: string;
  tracking: string;
  tracked: string;
  added: string;
  addFailed: string;
  reasonDeepLiquidity: string;
  reasonTradeableLiquidity: string;
  reasonThinLiquidity: string;
  reasonManyTrades: string;
  reasonTradeCountUnavailable: string;
  reasonWideRange: string;
  reasonModerateRange: string;
  reasonNarrowRange: string;
  reasonAlreadyTracked: string;
  /** Template with `{count}` and `{min}`. */
  excludedFlatTemplate: string;
  equitiesNote: string;
  empty: string;
  venueError: string;
  generatedAt: string;
  refresh: string;
  tradingStyle: string;
}

export function recommendLabels(t: Messages): RecommendLabels {
  return {
    notAPrediction: t.recommend.notAPrediction,
    howScored: t.recommend.howScored,
    howScoredBody: t.recommend.howScoredBody,
    filterExchange: t.recommend.filterExchange,
    filterBand: t.recommend.filterBand,
    allVenues: t.recommend.allVenues,
    anyBand: t.recommend.anyBand,
    bandLiquid: t.recommend.bandLiquid,
    bandActive: t.recommend.bandActive,
    bandSpeculative: t.recommend.bandSpeculative,
    bandThin: t.recommend.bandThin,
    bandLiquidHelp: t.recommend.bandLiquidHelp,
    bandActiveHelp: t.recommend.bandActiveHelp,
    bandSpeculativeHelp: t.recommend.bandSpeculativeHelp,
    bandThinHelp: t.recommend.bandThinHelp,
    colSymbol: t.recommend.colSymbol,
    colScore: t.recommend.colScore,
    colVolume: t.recommend.colVolume,
    colRange: t.recommend.colRange,
    colChange: t.recommend.colChange,
    colTrades: t.recommend.colTrades,
    colBand: t.recommend.colBand,
    colWhy: t.recommend.colWhy,
    scoreHelp: t.recommend.scoreHelp,
    volumeHelp: t.recommend.volumeHelp,
    rangeHelp: t.recommend.rangeHelp,
    tradesHelp: t.recommend.tradesHelp,
    track: t.recommend.track,
    tracking: t.recommend.tracking,
    tracked: t.recommend.tracked,
    added: t.recommend.added,
    addFailed: t.recommend.addFailed,
    reasonDeepLiquidity: t.recommend.reasonDeepLiquidity,
    reasonTradeableLiquidity: t.recommend.reasonTradeableLiquidity,
    reasonThinLiquidity: t.recommend.reasonThinLiquidity,
    reasonManyTrades: t.recommend.reasonManyTrades,
    reasonTradeCountUnavailable: t.recommend.reasonTradeCountUnavailable,
    reasonWideRange: t.recommend.reasonWideRange,
    reasonModerateRange: t.recommend.reasonModerateRange,
    reasonNarrowRange: t.recommend.reasonNarrowRange,
    reasonAlreadyTracked: t.recommend.reasonAlreadyTracked,
    // `{count}` / `{min}` are substituted on the client with `fill()`.
    excludedFlatTemplate: t.recommend.excludedFlat(-1, -1).replace('-1', '{count}').replace('-1', '{min}'),
    equitiesNote: t.recommend.equitiesNote,
    empty: t.recommend.empty,
    venueError: t.recommend.venueError,
    generatedAt: t.recommend.generatedAt,
    refresh: t.recommend.refresh,
    tradingStyle: t.watchlist.tradingStyle,
  };
}
