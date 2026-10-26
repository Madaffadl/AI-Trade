import type { AssetRef } from '@/lib/market/types';

/**
 * Deterministic risk and position-size arithmetic.
 *
 * Nothing here is financial advice: the defaults are configurable examples. The
 * module refuses to produce a position size when a required input is missing or
 * nonsensical, rather than returning a confident-looking number built on
 * guesses.
 */

export interface RiskInputs {
  entry: number;
  stop: number;
  targets: number[];
  accountEquity: number;
  riskPercentPerTrade: number;
  /** Round-trip cost assumption in basis points (entry + exit). */
  feeBps: number;
  slippageBps: number;
  asset: Pick<AssetRef, 'tickSize' | 'lotSize' | 'minNotional' | 'currency' | 'assetClass'>;
  /** 'long' only in this release; short selling is out of scope. */
  direction: 'long';
}

export interface RiskResult {
  ok: boolean;
  /** Reasons the calculation was refused. Empty when ok. */
  refusals: string[];
  riskPerUnit: number | null;
  stopDistancePct: number | null;
  positionSize: number | null;
  positionNotional: number | null;
  riskAmount: number | null;
  /** Gross R:R to the first target. */
  riskReward: number | null;
  /** R:R after assumed fees and slippage. */
  riskRewardNet: number | null;
  potentialLoss: number | null;
  targetOutcomes: { target: number; rewardPerUnit: number; profit: number | null; rr: number }[];
  costAssumptionNote: string;
  /** Disclosures about unknown tick/lot/fee inputs. Always shown in the UI. */
  disclosures: string[];
}

const EMPTY: Omit<RiskResult, 'ok' | 'refusals' | 'costAssumptionNote' | 'disclosures'> = {
  riskPerUnit: null,
  stopDistancePct: null,
  positionSize: null,
  positionNotional: null,
  riskAmount: null,
  riskReward: null,
  riskRewardNet: null,
  potentialLoss: null,
  targetOutcomes: [],
};

export function computeRisk(input: RiskInputs): RiskResult {
  const refusals: string[] = [];
  const disclosures: string[] = [];
  const { entry, stop, targets, accountEquity, riskPercentPerTrade, feeBps, slippageBps, asset } = input;

  if (!Number.isFinite(entry) || entry <= 0) refusals.push('Entry price is not a valid positive number.');
  if (!Number.isFinite(stop) || stop <= 0) refusals.push('Stop-loss price is not a valid positive number.');
  if (Number.isFinite(entry) && Number.isFinite(stop) && stop >= entry) {
    refusals.push('For a long setup the stop-loss must sit below the entry price.');
  }
  if (!Number.isFinite(accountEquity) || accountEquity <= 0) refusals.push('Account equity must be greater than zero.');
  if (!Number.isFinite(riskPercentPerTrade) || riskPercentPerTrade <= 0 || riskPercentPerTrade > 100) {
    refusals.push('Risk per trade must be between 0 and 100 percent.');
  }
  const validTargets = targets.filter((t) => Number.isFinite(t) && t > entry);
  if (validTargets.length === 0) refusals.push('No take-profit target above the entry price was supplied.');

  const costNote =
    `Assumes ${feeBps} bps round-trip fees and ${slippageBps} bps slippage. ` +
    'These are configured assumptions, not broker-specific values.';

  if (refusals.length > 0) {
    return { ok: false, refusals, ...EMPTY, costAssumptionNote: costNote, disclosures };
  }

  const riskPerUnit = entry - stop;
  const stopDistancePct = (riskPerUnit / entry) * 100;
  const riskAmount = accountEquity * (riskPercentPerTrade / 100);

  let positionSize = riskAmount / riskPerUnit;

  // Lot/tick rounding: only applied when the exchange's real increments are
  // known. Unknown increments are disclosed, never invented.
  if (asset.lotSize && asset.lotSize > 0) {
    positionSize = Math.floor(positionSize / asset.lotSize) * asset.lotSize;
    // Clean up binary floating-point dust from the division.
    positionSize = Number(positionSize.toFixed(10));
  } else {
    disclosures.push(
      'Lot/step size for this asset is unknown, so the position size is NOT rounded to a tradable increment.',
    );
  }
  if (!asset.tickSize) {
    disclosures.push('Tick size is unknown, so price levels are not rounded to the exchange price grid.');
  }

  if (positionSize <= 0) {
    return {
      ok: false,
      refusals: [
        'Risk budget is too small for one tradable unit at this stop distance. Widen the risk budget or pick a closer stop.',
      ],
      ...EMPTY,
      costAssumptionNote: costNote,
      disclosures,
    };
  }

  const positionNotional = positionSize * entry;
  if (asset.minNotional && positionNotional < asset.minNotional) {
    return {
      ok: false,
      refusals: [
        `Position notional ${positionNotional.toFixed(2)} ${asset.currency} is below the exchange minimum of ${asset.minNotional}.`,
      ],
      ...EMPTY,
      costAssumptionNote: costNote,
      disclosures,
    };
  }

  const costPerUnit = entry * ((feeBps + slippageBps) / 10_000);
  const potentialLoss = positionSize * riskPerUnit + positionSize * costPerUnit;

  const targetOutcomes = validTargets.map((t) => {
    const rewardPerUnit = t - entry;
    return {
      target: t,
      rewardPerUnit,
      profit: positionSize * rewardPerUnit - positionSize * costPerUnit,
      rr: rewardPerUnit / riskPerUnit,
    };
  });

  const firstTarget = validTargets[0]!;
  const riskReward = (firstTarget - entry) / riskPerUnit;
  // Costs are charged against the reward and added to the risk, which is the
  // conservative reading.
  const riskRewardNet = (firstTarget - entry - costPerUnit) / (riskPerUnit + costPerUnit);

  return {
    ok: true,
    refusals: [],
    riskPerUnit,
    stopDistancePct,
    positionSize,
    positionNotional,
    riskAmount,
    riskReward,
    riskRewardNet,
    potentialLoss,
    targetOutcomes,
    costAssumptionNote: costNote,
    disclosures,
  };
}

/**
 * Default cost assumptions per asset class, in basis points.
 * Crypto spot taker fees are commonly ~10 bps round trip; equity commissions at
 * retail brokers are often zero but spread/slippage still applies. These are
 * documented assumptions, not quotes from any specific venue.
 */
export function defaultCostAssumptions(assetClass: 'crypto' | 'stock'): { feeBps: number; slippageBps: number } {
  return assetClass === 'crypto' ? { feeBps: 10, slippageBps: 5 } : { feeBps: 2, slippageBps: 5 };
}

/** Total open risk across signals, used to enforce a maximum-exposure cap. */
export function aggregateOpenRisk(
  openRisks: readonly number[],
  accountEquity: number,
): { totalRisk: number; percentOfEquity: number | null } {
  const totalRisk = openRisks.reduce((s, r) => s + r, 0);
  return {
    totalRisk,
    percentOfEquity: accountEquity > 0 ? (totalRisk / accountEquity) * 100 : null,
  };
}
