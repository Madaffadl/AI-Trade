/**
 * Generic cost assumptions used by the historical evaluation of stored signals.
 *
 * Indodax plans do NOT use these: they take the real taker fee from the
 * exchange, the measured spread and the sale tax (see lib/plan/costs.ts). The
 * position-sizing helpers that used to live here were superseded by
 * lib/plan/sizing.ts and removed on 2026-10-29.
 */

/**
 * Default cost assumptions per asset class, in basis points.
 * Crypto spot taker fees are commonly ~10 bps round trip; equity commissions at
 * retail brokers are often zero but spread/slippage still applies. These are
 * documented assumptions, not quotes from any specific venue.
 */
export function defaultCostAssumptions(assetClass: 'crypto' | 'stock'): { feeBps: number; slippageBps: number } {
  return assetClass === 'crypto' ? { feeBps: 10, slippageBps: 5 } : { feeBps: 2, slippageBps: 5 };
}
