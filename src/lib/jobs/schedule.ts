/**
 * When the worker's jobs are due. Pure, so the timing rules are tested as
 * they run.
 *
 * Indodax candles close on the UTC hour (1h every hour, 4h at 00/04/08/12/16/20
 * UTC, daily at 00 UTC = 07:00 WIB). The scan runs once per hour, `offsetMs`
 * after the close, so the candle it reads is final; the live monitor covers
 * the minutes in between.
 */

const HOUR = 3_600_000;

/** The latest scheduled scan time at or before `now`. */
export function latestScanSlot(now: number, offsetMs: number): number {
  return Math.floor((now - offsetMs) / HOUR) * HOUR + offsetMs;
}

/**
 * Due when no scan has started since the latest slot, or - after a scan that
 * found no usable data - once `retryMs` has passed, rather than waiting an
 * hour with nothing to show.
 */
export function scanDue(
  now: number,
  lastScan: { startedAtMs: number; failed: boolean } | null,
  offsetMs: number,
  retryMs = 5 * 60_000,
): boolean {
  if (!lastScan) return true;
  if (lastScan.startedAtMs < latestScanSlot(now, offsetMs)) return true;
  return lastScan.failed && now - lastScan.startedAtMs >= retryMs;
}

/** Due when it never ran or `intervalMs` has passed since it last did. */
export function intervalDue(now: number, lastRunMs: number | null, intervalMs: number): boolean {
  return lastRunMs === null || now - lastRunMs >= intervalMs;
}
