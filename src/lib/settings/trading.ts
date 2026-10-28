import 'server-only';
import { z } from 'zod';
import { getSetting, setSetting } from '@/lib/db/repo';

/**
 * The user's trading configuration: capital, risk limits, cost assumptions
 * and which Indodax pairs are worth scanning.
 *
 * Stored in the database (not .env) so it can be changed from the Settings
 * page. Every field has a conservative default and hard bounds; a stored value
 * that is missing or out of bounds falls back to its default individually, so
 * one bad field can never silently disable risk control as a whole.
 *
 * These are the user's own choices, not advice - the defaults are examples.
 */

const SETTINGS_KEY = 'trading.settings';

const FIELDS = {
  /** Total capital set aside for trading on Indodax, in IDR. */
  capitalIdr: z.number().min(10_000).max(100_000_000_000),
  /** Part of the capital that must never be used (e.g. an emergency buffer). */
  reservedIdr: z.number().min(0).max(100_000_000_000),
  /** Loss accepted per trade if the stop-loss is hit, as % of usable capital. */
  riskPercent: z.number().min(0.1).max(5),
  /** Largest share of usable capital one position may take. */
  maxAllocationPercent: z.number().min(5).max(100),
  maxOpenPositions: z.number().int().min(1).max(10),
  /** New entries stop for the day once realised losses reach this % of capital. */
  maxDailyLossPercent: z.number().min(0.5).max(20),
  /** A setup is only eligible if its reward:risk after all costs reaches this. */
  minNetRiskReward: z.number().min(1).max(5),
  /** Final tax withheld on the sale of crypto (PMK 50/2025 rate for local exchanges). */
  sellTaxPercent: z.number().min(0).max(2),
  /** Exchange levies charged per side on top of the trading fee (e.g. CFX). */
  otherFeePercentPerSide: z.number().min(0).max(1),
  /** Universe filter: minimum 24h turnover in IDR. */
  minVolumeIdr: z.number().min(0).max(1_000_000_000_000),
  /** Universe filter: widest acceptable bid/ask spread, in %. */
  maxSpreadPercent: z.number().min(0.01).max(5),
  /** Universe filter: how many pairs to scan at most. */
  universeSize: z.number().int().min(2).max(60),
  /** Open a paper trade automatically for each top BUY NOW setup. */
  autoSimulate: z.boolean(),
  /** Virtual capital the simulation starts from. */
  simStartCapitalIdr: z.number().min(10_000).max(100_000_000_000),
} as const;

export type TradingSettings = { [K in keyof typeof FIELDS]: z.infer<(typeof FIELDS)[K]> };

/** Conservative example defaults; the user changes them on the Settings page. */
export function defaultTradingSettings(): TradingSettings {
  const capital = 1_000_000;
  return {
    capitalIdr: capital,
    reservedIdr: 0,
    riskPercent: 1,
    maxAllocationPercent: 50,
    maxOpenPositions: 2,
    maxDailyLossPercent: 3,
    minNetRiskReward: 1.5,
    sellTaxPercent: 0.21,
    otherFeePercentPerSide: 0.0111,
    minVolumeIdr: 1_000_000_000,
    maxSpreadPercent: 0.5,
    universeSize: 25,
    autoSimulate: true,
    simStartCapitalIdr: capital,
  };
}

/** Merge stored values over defaults, field by field, dropping invalid ones. */
export function resolveTradingSettings(stored: unknown, defaults: TradingSettings): TradingSettings {
  const out = { ...defaults };
  if (stored && typeof stored === 'object') {
    const record = stored as Record<string, unknown>;
    for (const key of Object.keys(FIELDS) as (keyof TradingSettings)[]) {
      const parsed = FIELDS[key].safeParse(record[key]);
      if (parsed.success) (out as Record<string, unknown>)[key] = parsed.data;
    }
  }
  return out;
}

/** Strict validation for an update from the Settings form. */
export const TradingSettingsUpdate = z.object(FIELDS).partial().strict();

export async function getTradingSettings(): Promise<TradingSettings> {
  return resolveTradingSettings(await getSetting<unknown>(SETTINGS_KEY, null), defaultTradingSettings());
}

export async function updateTradingSettings(update: unknown): Promise<TradingSettings> {
  const parsed = TradingSettingsUpdate.parse(update);
  const next = { ...(await getTradingSettings()), ...parsed };
  if (next.reservedIdr >= next.capitalIdr) {
    throw new z.ZodError([
      { code: 'custom', path: ['reservedIdr'], message: 'Reserved capital must be smaller than total capital.', input: next.reservedIdr },
    ]);
  }
  await setSetting(SETTINGS_KEY, next);
  return next;
}

/** Capital the plan engine may actually use. */
export function usableCapital(s: Pick<TradingSettings, 'capitalIdr' | 'reservedIdr'>): number {
  return Math.max(0, s.capitalIdr - s.reservedIdr);
}
