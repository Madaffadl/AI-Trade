/**
 * Display formatting helpers. Pure functions, safe on client and server.
 *
 * Price precision adapts to magnitude: IDR equities trade in thousands where
 * decimals are noise, while a low-priced crypto pair needs several decimals.
 */

export function formatPrice(value: number | null | undefined, currency?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 10_000 ? 0 : abs >= 100 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  const formatted = value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return currency ? `${formatted} ${currency}` : formatted;
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

/**
 * Direction glyph for a signed value.
 *
 * Red/green alone is unreadable for roughly 1 in 12 men, so every value that
 * carries direction through colour also carries this shape. The measured
 * deuteranopia separation of the up/down pair is ΔE 8.2 - above the threshold,
 * but a glyph costs nothing and removes the dependency entirely.
 */
export function directionGlyph(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return '';
  return value > 0 ? '▲' : '▼';
}

/** Signed percentage prefixed with its direction glyph. */
export function formatPercentSigned(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const glyph = directionGlyph(value);
  return `${glyph ? `${glyph} ` : ''}${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * Indicator values at a sensible precision for their magnitude.
 *
 * A fixed decimal count cannot serve both an ATR of 32,511,503 IDR and a MACD
 * histogram of -0.0042. Four decimals on the first is noise; zero on the second
 * erases the value.
 */
export function formatIndicator(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : abs >= 10 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 4 : 6;
  // `maximumFractionDigits` alone, so trailing zeros are dropped: a stat tile is
  // not a column that needs to align, and "-0.004200" is padding, not precision.
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** Absolute UTC timestamp. Every time in this app is UTC to avoid ambiguity. */
export function formatUtc(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function formatDateUtc(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

/** Relative age, e.g. "14m ago". Pairs with an absolute timestamp, never replaces it. */
export function formatAge(ms: number | null | undefined, nowMs = Date.now()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const delta = nowMs - ms;
  if (delta < 0) return 'in the future';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function directionClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'text-ink-muted';
  if (value > 0) return 'text-up';
  if (value < 0) return 'text-down';
  return 'text-flat';
}

/**
 * Rupiah, Indonesian style: "Rp1.465.298.000". Prices under Rp100 (micro-priced
 * coins such as PEPE) keep four significant digits instead of rounding to 0.
 */
export function formatIdr(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 100 ? { maximumFractionDigits: 0 } : { maximumSignificantDigits: 4 };
  return `${value < 0 ? '−' : ''}Rp${abs.toLocaleString('id-ID', digits)}`;
}

/** Signed Rupiah with a direction glyph, so colour is never the only cue: "▲ +Rp12.500". */
export function formatIdrSigned(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const glyph = directionGlyph(value);
  const body = `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatIdr(Math.abs(value))}`;
  return glyph ? `${glyph} ${body}` : body;
}

/** Coin quantity with up to 8 decimals, Indonesian separators. */
export function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('id-ID', { maximumFractionDigits: 8 });
}

/**
 * Wall-clock time in Indonesia (WIB), labelled as such. Trading decisions are
 * made on the Indonesian clock, so plan deadlines are shown in WIB rather than
 * the UTC used for data provenance elsewhere.
 */
export function formatWib(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ms);
  return `${s} WIB`;
}

/** Calendar date in Indonesia, with the year: "14 Okt 2025". */
export function formatDateWib(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric' }).format(ms);
}
