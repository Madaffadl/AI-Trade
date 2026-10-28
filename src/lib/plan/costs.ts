/**
 * Trading-cost model for an Indodax spot round trip (buy, then sell).
 *
 * Every component is a percentage of the traded value on that side:
 *   buy  = taker fee + other levies + half the bid/ask spread
 *   sell = taker fee + sale tax + other levies + half the bid/ask spread
 *
 * The taker fee comes from Indodax's own /api/pairs (0.2% on every IDR pair
 * on 2026-10-28); the spread is MEASURED from the live order book, so thin
 * pairs cost what they really cost. Tax and levies are the user's settings
 * because no official figure could be confirmed. Taker (not maker) is
 * assumed throughout: a plan that has to be followed reliably uses market or
 * marketable orders, and assuming the cheaper maker fee would flatter it.
 *
 * Pure module - no I/O - so the arithmetic is unit-tested directly.
 */

export interface CostModel {
  buyFeePercent: number;
  sellFeePercent: number;
  sellTaxPercent: number;
  otherPercentPerSide: number;
  /** Expected slippage per side: half the quoted spread. */
  halfSpreadPercent: number;
}

export function buildCostModel(input: {
  takerFeePercent: number;
  spreadPercent: number;
  sellTaxPercent: number;
  otherFeePercentPerSide: number;
}): CostModel {
  return {
    buyFeePercent: input.takerFeePercent,
    sellFeePercent: input.takerFeePercent,
    sellTaxPercent: input.sellTaxPercent,
    otherPercentPerSide: input.otherFeePercentPerSide,
    halfSpreadPercent: Math.max(0, input.spreadPercent) / 2,
  };
}

export function entryCostPercent(m: CostModel): number {
  return m.buyFeePercent + m.otherPercentPerSide + m.halfSpreadPercent;
}

export function exitCostPercent(m: CostModel): number {
  return m.sellFeePercent + m.sellTaxPercent + m.otherPercentPerSide + m.halfSpreadPercent;
}

/** Cost of a full round trip, in % of the traded value (entry and exit treated as equal value). */
export function roundTripCostPercent(m: CostModel): number {
  return entryCostPercent(m) + exitCostPercent(m);
}

/** Costs in IDR for one unit bought at `entry` and sold at `exit`. */
export function costPerUnit(entry: number, exit: number, m: CostModel): { entry: number; exit: number; total: number } {
  const e = (entry * entryCostPercent(m)) / 100;
  const x = (exit * exitCostPercent(m)) / 100;
  return { entry: e, exit: x, total: e + x };
}

/** Net result in IDR of `quantity` units bought at `entry` and sold at `exit`, after all costs. */
export function netPnl(entry: number, exit: number, quantity: number, m: CostModel): number {
  return quantity * (exit - entry) - quantity * costPerUnit(entry, exit, m).total;
}
