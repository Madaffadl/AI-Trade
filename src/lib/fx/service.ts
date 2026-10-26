import 'server-only';
import { getSetting, setSetting } from '@/lib/db/repo';
import { httpJson, ProviderError } from '@/lib/providers/http';

/**
 * Foreign exchange rates, for DISPLAY ONLY.
 *
 * Hard rule enforced by convention throughout the app: a converted price is
 * never stored, never fed into an indicator, never used for position sizing,
 * and never used to compute profit and loss. Signals and P&L stay in the
 * currency you actually traded in. Conversion exists so you can eyeball a USD
 * stock and an IDR coin on one screen, and every converted number is marked
 * with "≈" plus the rate and its age.
 *
 * Source: open.er-api.com - free, no key, updates roughly daily.
 */

export const SUPPORTED_DISPLAY = ['native', 'USD', 'IDR'] as const;
export type DisplayCurrency = (typeof SUPPORTED_DISPLAY)[number];

interface RateCache {
  base: 'USD';
  rates: Record<string, number>;
  /** When the PROVIDER last updated the rates. */
  providerUpdatedAtMs: number;
  /** When WE fetched them. */
  fetchedAtMs: number;
}

const SETTING_KEY = 'fx.rates.usd';
/** Rates update about once a day, so refetching more often is wasted quota. */
const TTL_MS = 6 * 3_600_000;

interface ErApiResponse {
  result: string;
  base_code: string;
  time_last_update_unix: number;
  rates: Record<string, number>;
}

/**
 * Current USD-based rates, cached in the database.
 * Returns null when no rate is available and none is cached - callers then
 * fall back to showing native currency rather than guessing.
 */
export async function getRates(options: { force?: boolean } = {}): Promise<RateCache | null> {
  const cached = await getSetting<RateCache | null>(SETTING_KEY, null);
  const fresh = cached && Date.now() - cached.fetchedAtMs < TTL_MS;
  if (fresh && !options.force) return cached;

  try {
    const raw = await httpJson<ErApiResponse>('https://open.er-api.com/v6/latest/USD', { timeoutMs: 15_000 });
    if (raw.result !== 'success' || !raw.rates || typeof raw.rates.IDR !== 'number') {
      throw new ProviderError('FX provider returned no usable rates.', 'bad_payload');
    }
    const next: RateCache = {
      base: 'USD',
      rates: raw.rates,
      providerUpdatedAtMs: Number(raw.time_last_update_unix) * 1000,
      fetchedAtMs: Date.now(),
    };
    await setSetting(SETTING_KEY, next);
    return next;
  } catch {
    // A stale rate, clearly labelled, beats no prices at all. Null beats a
    // made-up rate.
    return cached ?? null;
  }
}

export interface FxContext {
  target: DisplayCurrency;
  rates: RateCache | null;
}

export async function fxContext(target: DisplayCurrency): Promise<FxContext> {
  if (target === 'native') return { target, rates: null };
  return { target, rates: await getRates() };
}

export interface ConvertedMoney {
  /** Value to display. */
  value: number | null;
  /** Currency the displayed value is in. */
  currency: string;
  /** True when a conversion was applied (render with "≈"). */
  converted: boolean;
  /** Original value and currency, always preserved. */
  nativeValue: number | null;
  nativeCurrency: string;
  /** Rate used, for the tooltip. */
  rate: number | null;
  rateAgeMs: number | null;
  note: string | null;
}

/**
 * Convert a price for display.
 *
 * Returns the native value unchanged when: the target is 'native', the
 * currencies already match, no rate is cached, or either currency is missing
 * from the rate table. Every one of those cases is a reason to show the real
 * number rather than approximate it.
 */
export function convertForDisplay(
  value: number | null | undefined,
  nativeCurrency: string,
  ctx: FxContext,
): ConvertedMoney {
  const native: ConvertedMoney = {
    value: value ?? null,
    currency: nativeCurrency,
    converted: false,
    nativeValue: value ?? null,
    nativeCurrency,
    rate: null,
    rateAgeMs: null,
    note: null,
  };

  if (value === null || value === undefined || !Number.isFinite(value)) return native;
  if (ctx.target === 'native' || ctx.target === nativeCurrency) return native;

  const rates = ctx.rates;
  if (!rates) {
    return { ...native, note: 'No exchange rate available, so the native currency is shown.' };
  }

  // Stablecoin quotes are treated as their fiat peg for display only. This is
  // an approximation: USDT is not exactly USD, and it has de-pegged before.
  const from = normaliseCurrency(nativeCurrency);
  const to = normaliseCurrency(ctx.target);
  if (from === to) return native;

  const rateFrom = from === 'USD' ? 1 : rates.rates[from];
  const rateTo = to === 'USD' ? 1 : rates.rates[to];
  if (!rateFrom || !rateTo || !Number.isFinite(rateFrom) || !Number.isFinite(rateTo)) {
    return { ...native, note: `No rate for ${from}→${to}; showing the native currency.` };
  }

  // value is in `from`; USD amount = value / rateFrom; target = that × rateTo.
  const converted = (value / rateFrom) * rateTo;
  const effectiveRate = rateTo / rateFrom;

  return {
    value: converted,
    currency: ctx.target,
    converted: true,
    nativeValue: value,
    nativeCurrency,
    rate: effectiveRate,
    rateAgeMs: Date.now() - rates.providerUpdatedAtMs,
    note:
      STABLECOINS.has(nativeCurrency.toUpperCase())
        ? `${nativeCurrency} treated as USD for display; it is a stablecoin, not dollars.`
        : null,
  };
}

const STABLECOINS = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD']);

/** Map stablecoins onto their peg so a USDT price can be shown in IDR. */
function normaliseCurrency(code: string): string {
  const upper = code.toUpperCase();
  return STABLECOINS.has(upper) ? 'USD' : upper;
}

/** The user's chosen display currency, stored as a non-secret app setting. */
export async function getDisplayCurrencySetting(): Promise<DisplayCurrency> {
  const value = await getSetting<string>('display.currency', 'native');
  return (SUPPORTED_DISPLAY as readonly string[]).includes(value) ? (value as DisplayCurrency) : 'native';
}

export async function setDisplayCurrencySetting(value: DisplayCurrency): Promise<void> {
  await setSetting('display.currency', value);
}
