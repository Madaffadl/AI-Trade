import 'server-only';
import type { Db } from '@/lib/db/driver';
import { db } from '@/lib/db/driver';
import { newId } from '@/lib/db/repo';

/**
 * Cross-process mutual exclusion through the database.
 *
 * The scan and the live monitor both advance paper trades and setup states;
 * running two at once could fill the same simulated order twice. They can be
 * started by the worker and by the "Refresh now" button, which live in
 * different processes, so an in-memory flag is not enough.
 *
 * A lock is a row keyed by name. Taking it is a single INSERT that the primary
 * key makes atomic on SQLite and Postgres alike. A row whose `expires_at_ms`
 * has passed belonged to a process that died mid-job and is removed first.
 */

export const MARKET_LOCK = 'market';

/** Another process holds the lock; nothing was run. */
export class JobBusyError extends Error {
  constructor(readonly lock: string) {
    super(`"${lock}" is already running in another process.`);
    this.name = 'JobBusyError';
  }
}

export async function tryAcquire(d: Db, name: string, ttlMs: number, now = Date.now()): Promise<string | null> {
  const holder = newId();
  await d.run('DELETE FROM job_locks WHERE name = ? AND expires_at_ms < ?', [name, now]);
  await d.run(
    `INSERT INTO job_locks (name, holder, acquired_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO NOTHING`,
    [name, holder, now, now + ttlMs],
  );
  const row = await d.get<{ holder: string }>('SELECT holder FROM job_locks WHERE name = ?', [name]);
  return row?.holder === holder ? holder : null;
}

export async function release(d: Db, name: string, holder: string): Promise<void> {
  await d.run('DELETE FROM job_locks WHERE name = ? AND holder = ?', [name, holder]);
}

/** Locks this process holds right now, so a shutdown can hand them back. */
const held = new Map<string, string>();

/**
 * Run `fn` while holding the lock. If another process holds it, retry for up
 * to `waitMs` (default: not at all), then throw JobBusyError. The lock is
 * released even when `fn` throws.
 */
export async function withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>, waitMs = 0): Promise<T> {
  const d = await db();
  const deadline = Date.now() + waitMs;
  let holder = await tryAcquire(d, name, ttlMs);
  while (!holder && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    holder = await tryAcquire(d, name, ttlMs);
  }
  if (!holder) throw new JobBusyError(name);
  held.set(name, holder);
  try {
    return await fn();
  } finally {
    held.delete(name);
    await release(d, name, holder);
  }
}

/** Release every lock this process holds (on Ctrl+C, before exiting). */
export async function releaseHeldLocks(): Promise<void> {
  const d = await db();
  for (const [name, holder] of held) await release(d, name, holder);
  held.clear();
}
