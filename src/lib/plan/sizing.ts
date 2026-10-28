import { costPerUnit, entryCostPercent, type CostModel } from './costs';
import type { SizingResult } from './types';

/**
 * Position size for one plan, in coin units and IDR.
 *
 * Three ceilings, smallest wins:
 *   risk        loss at the stop (price distance + all costs) = risk% of usable capital
 *   allocation  one position never takes more than maxAllocation% of usable capital
 *   cash        never more than the cash not already tied up in open positions
 *
 * With small accounts the allocation or cash cap usually binds before the
 * risk budget does - then the real risk is LOWER than the configured %, and
 * `effectiveRiskPercent` says so. The quantity is rounded DOWN to the pair's
 * quantity step, and a result below Indodax's minimum order is refused rather
 * than rounded up (rounding up would exceed the risk the user chose).
 */

export interface SizingInput {
  entry: number;
  stop: number;
  usableCapitalIdr: number;
  cashAvailableIdr: number;
  riskPercent: number;
  maxAllocationPercent: number;
  quantityIncrement: number | null;
  minOrderIdr: number | null;
  costs: CostModel;
}

export function floorToStep(quantity: number, step: number | null): number {
  if (!step || step <= 0 || !Number.isFinite(quantity)) return quantity;
  const decimals = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
  // The epsilon absorbs binary noise (0.3 / 0.1 = 2.9999...) without ever rounding up a real shortfall.
  return Number((Math.floor(quantity / step + 1e-9) * step).toFixed(decimals));
}

export function sizePosition(i: SizingInput): SizingResult {
  const riskBudgetIdr = Math.max(0, i.usableCapitalIdr) * (i.riskPercent / 100);
  const riskPerUnit = i.entry - i.stop + costPerUnit(i.entry, i.stop, i.costs).total;
  const outlayPerUnit = i.entry * (1 + entryCostPercent(i.costs) / 100);

  const byRisk = riskPerUnit > 0 ? riskBudgetIdr / riskPerUnit : 0;
  const byAllocation = (Math.max(0, i.usableCapitalIdr) * (i.maxAllocationPercent / 100)) / outlayPerUnit;
  const byCash = Math.max(0, i.cashAvailableIdr) / outlayPerUnit;

  const raw = Math.min(byRisk, byAllocation, byCash);
  const limitedBy = raw === byRisk ? 'risk' : raw === byAllocation ? 'allocation' : 'cash';
  const quantity = floorToStep(Math.max(0, raw), i.quantityIncrement);
  const notionalIdr = quantity * i.entry;
  const lossAtStopIdr = quantity * Math.max(0, riskPerUnit);

  let failure: SizingResult['failure'] = null;
  if (i.usableCapitalIdr <= 0 || i.cashAvailableIdr <= 0) failure = 'no_capital';
  else if (quantity <= 0 || (i.minOrderIdr !== null && notionalIdr < i.minOrderIdr)) failure = 'below_min_order';

  return {
    ok: failure === null,
    failure,
    quantity,
    notionalIdr,
    entryCostIdr: (notionalIdr * entryCostPercent(i.costs)) / 100,
    riskBudgetIdr,
    lossAtStopIdr,
    effectiveRiskPercent: i.usableCapitalIdr > 0 ? (lossAtStopIdr / i.usableCapitalIdr) * 100 : 0,
    limitedBy,
  };
}
