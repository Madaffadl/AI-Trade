import type { Db } from './driver';

/**
 * Ordered, append-only migration steps.
 *
 * schema.sql is re-applied on every migrate and only ever uses
 * `CREATE ... IF NOT EXISTS`, which cannot add a column to an existing table
 * or correct existing rows. Those changes live here instead, each recorded in
 * `schema_migrations` so it runs exactly once per database.
 *
 * Rules: never edit, reorder or delete a shipped step - add a new one. Every
 * step must be safe on an empty database, because fresh installs run them all.
 */
export interface Migration {
  id: string;
  description: string;
  up(d: Db): Promise<void>;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '2026-10-29-indonesian-default',
    description: 'Indonesian becomes the default interface language (product directive: Indonesian first).',
    async up(d) {
      await d.run(
        `UPDATE application_settings SET value_json = ?, updated_at_ms = ?
          WHERE key = 'display.locale' AND value_json = ?`,
        [JSON.stringify('id'), Date.now(), JSON.stringify('en')],
      );
    },
  },
  {
    id: '2026-10-29-indodax-lot-size-is-a-step',
    description:
      "Indodax lot_size held the pair's MINIMUM order quantity, which position sizing then used as a STEP size. " +
      'Clear it; the universe refresh re-fills it with the real quantity_increment.',
    async up(d) {
      await d.run(`UPDATE assets SET lot_size = NULL WHERE exchange_id = 'INDODAX'`);
      // The catalogue table was removed later the same day; fresh databases never have it.
      if (await tableExists(d, 'instrument_catalog')) {
        await d.run(`UPDATE instrument_catalog SET lot_size = NULL WHERE exchange_id = 'INDODAX'`);
      }
    },
  },
  {
    id: '2026-10-29-indodax-only',
    description:
      'The app is scoped to Indodax: drop the stock / Binance / Coinbase assets and their data, the watchlist, ' +
      'the instrument catalogue, manual price thresholds, the display-currency settings and stale provider rows. ' +
      'An asset that still has a recorded position is kept, because deleting it would delete the position.',
    async up(d) {
      await d.run(
        `DELETE FROM assets WHERE exchange_id <> 'INDODAX' AND id NOT IN (SELECT asset_id FROM positions)`,
      );
      await d.run(
        `DELETE FROM exchanges WHERE id <> 'INDODAX' AND id NOT IN (SELECT DISTINCT exchange_id FROM assets)`,
      );
      for (const table of ['watchlist_assets', 'watchlists', 'price_thresholds', 'instrument_catalog', 'technical_indicator_snapshots']) {
        await d.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      await d.run(`DELETE FROM application_settings WHERE key IN ('display.currency', 'fx.rates.usd')`);
      await d.run(
        `DELETE FROM provider_status
          WHERE provider IN ('binance', 'coinbase', 'nasdaq', 'alphavantage', 'twelvedata', 'yahoo', 'sec_8k')
             OR (operation = 'ai' AND provider IN ('gemini', 'groq'))`,
      );
    },
  },
];

/** Whether a table exists, on either dialect. */
export async function tableExists(d: Db, name: string): Promise<boolean> {
  const row =
    d.dialect === 'sqlite'
      ? await d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`, [name])
      : await d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = ?`, [name]);
  return Number(row?.n ?? 0) > 0;
}

/** Apply every step not yet recorded. Returns the ids applied in this call. */
export async function runMigrations(d: Db, steps: readonly Migration[] = MIGRATIONS): Promise<string[]> {
  const done = new Set((await d.all<{ id: string }>('SELECT id FROM schema_migrations')).map((r) => r.id));
  const applied: string[] = [];
  for (const step of steps) {
    if (done.has(step.id)) continue;
    await step.up(d);
    // Two processes starting together may both apply a step (every step is
    // idempotent); only the first records it.
    await d.run('INSERT INTO schema_migrations (id, applied_at_ms) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', [step.id, Date.now()]);
    applied.push(step.id);
  }
  return applied;
}
