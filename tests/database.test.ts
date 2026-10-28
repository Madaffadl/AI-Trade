import { beforeAll, describe, expect, it } from 'vitest';
import { migrate, openMemoryDb, splitStatements, type Db } from '@/lib/db/driver';
import { readFileSync } from 'node:fs';

/**
 * Integration tests against a real SQLite database using the production
 * schema.sql. They verify that the portable DDL actually executes and that the
 * duplicate-prevention constraints behave as the application relies on.
 */

let db: Db;

beforeAll(async () => {
  db = await openMemoryDb();
  await migrate(db);
});

const REQUIRED_TABLES = [
  'assets',
  'exchanges',
  'market_candles',
  'news_articles',
  'news_asset_impacts',
  'analysis_runs',
  'strategy_definitions',
  'trading_signals',
  'signal_evaluations',
  'alerts',
  'notification_deliveries',
  'provider_status',
  'application_settings',
  'positions',
  'schema_migrations',
  'scan_runs',
  'trade_setups',
  'sim_trades',
  'strategy_validations',
];

describe('schema', () => {
  it('creates every table the specification requires', async () => {
    const rows = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    const names = rows.map((r) => r.name);
    for (const table of REQUIRED_TABLES) {
      expect(names, `missing table ${table}`).toContain(table);
    }
  });

  it('is idempotent - re-applying the schema is a no-op', async () => {
    await expect(migrate(db)).resolves.toBeTruthy();
  });

  it('creates the indexes used by the hot queries', async () => {
    const rows = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'");
    const names = rows.map((r) => r.name);
    expect(names).toContain('idx_candles_lookup');
    expect(names).toContain('idx_signals_feed');
  });

  it('uses only portable column types in the executable DDL', () => {
    // Comments are stripped first: they legitimately discuss the dialect-
    // specific types this schema deliberately avoids.
    const executable = splitStatements(readFileSync('src/lib/db/schema.sql', 'utf8')).join(';\n');
    for (const forbidden of [/\bSERIAL\b/i, /\bAUTOINCREMENT\b/i, /\bJSONB\b/i, /\bTIMESTAMPTZ\b/i, /\bUUID\b/i]) {
      expect(executable, `DDL must not use ${forbidden}`).not.toMatch(forbidden);
    }
  });
});

describe('duplicate prevention', () => {
  beforeAll(async () => {
    await db.run(
      `INSERT INTO exchanges (id, name, asset_class, timezone, continuous, created_at_ms) VALUES ('X','X','crypto','UTC',1,0)`,
    );
    await db.run(
      `INSERT INTO assets (id, symbol, display_name, asset_class, exchange_id, currency, active, created_at_ms)
       VALUES ('a1','TEST','Test','crypto','X','USD',1,0)`,
    );
  });

  it('upserts a candle on (asset, timeframe, open_time) rather than duplicating it', async () => {
    const insert = (close: number, fetchedAt: number) =>
      db.run(
        `INSERT INTO market_candles (asset_id, timeframe, open_time_ms, close_time_ms, open, high, low, close, volume, provider, fetched_at_ms, is_partial, quality)
         VALUES ('a1','1h',1000,4600000,1,2,0.5,?,10,'test',?,0,'ok')
         ON CONFLICT (asset_id, timeframe, open_time_ms) DO UPDATE SET close = excluded.close, fetched_at_ms = excluded.fetched_at_ms`,
        [close, fetchedAt],
      );

    await insert(100, 1);
    await insert(105, 2);

    const rows = await db.all<{ close: number; fetched_at_ms: number }>(
      'SELECT close, fetched_at_ms FROM market_candles WHERE asset_id = ?',
      ['a1'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.close).toBe(105);
    // Candle time and retrieval time remain separate facts.
    expect(rows[0]!.fetched_at_ms).toBe(2);
  });

  it('rejects a second signal with the same signal_key', async () => {
    const insert = () =>
      db.run(
        `INSERT INTO trading_signals (id, signal_key, asset_id, timeframe, trading_style, strategy_id, strategy_version,
           action, strength, generated_at_ms, candle_open_ms, data_fetched_ms, price_at_signal, regime, data_quality,
           reasons_json, risks_json, invalidation_json, indicators_json, status)
         VALUES (?, 'key-1','a1','1h','swing','s','1.0.0','BUY','moderate',1,1,1,100,'uptrend','ok','{}','[]','[]','{}','active')`,
        [crypto.randomUUID()],
      );
    await insert();
    await expect(insert()).rejects.toThrow();

    const rows = await db.all('SELECT id FROM trading_signals WHERE signal_key = ?', ['key-1']);
    expect(rows).toHaveLength(1);
  });

  it('rejects a second alert with the same dedupe_key', async () => {
    const insert = () =>
      db.run(
        `INSERT INTO alerts (id, dedupe_key, kind, severity, title, body, created_at_ms)
         VALUES (?, 'alert-1','new_signal','info','t','b',1)`,
        [crypto.randomUUID()],
      );
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it('rejects a duplicate news article dedupe_key', async () => {
    const insert = () =>
      db.run(
        `INSERT INTO news_articles (id, dedupe_key, headline, url, publisher, feed_id, fetched_at_ms)
         VALUES (?, 'news-1','h','https://example.com','p','f',1)`,
        [crypto.randomUUID()],
      );
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it('enforces one evaluation per (signal, horizon)', async () => {
    const signalId = crypto.randomUUID();
    await db.run(
      `INSERT INTO trading_signals (id, signal_key, asset_id, timeframe, trading_style, strategy_id, strategy_version,
         action, strength, generated_at_ms, candle_open_ms, data_fetched_ms, price_at_signal, regime, data_quality,
         reasons_json, risks_json, invalidation_json, indicators_json, status)
       VALUES (?, 'key-eval','a1','1h','swing','s','1.0.0','BUY','moderate',1,1,1,100,'uptrend','ok','{}','[]','[]','{}','active')`,
      [signalId],
    );
    const insert = (outcome: string) =>
      db.run(
        `INSERT INTO signal_evaluations (id, signal_id, evaluated_at_ms, horizon_bars, horizon_end_ms, bars_observed,
           outcome, fee_assumption_bps, slippage_assumption_bps, overlaps_prior)
         VALUES (?, ?, 1, 20, 100, 5, ?, 10, 5, 0)
         ON CONFLICT (signal_id, horizon_bars) DO UPDATE SET outcome = excluded.outcome`,
        [crypto.randomUUID(), signalId, outcome],
      );
    await insert('pending');
    await insert('target_hit');

    const rows = await db.all<{ outcome: string }>('SELECT outcome FROM signal_evaluations WHERE signal_id = ?', [
      signalId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('target_hit');
  });

  it('enforces referential integrity on candles', async () => {
    await expect(
      db.run(
        `INSERT INTO market_candles (asset_id, timeframe, open_time_ms, close_time_ms, open, high, low, close, provider, fetched_at_ms, is_partial, quality)
         VALUES ('does-not-exist','1h',1,2,1,1,1,1,'test',1,0,'ok')`,
      ),
    ).rejects.toThrow();
  });
});

describe('secret hygiene', () => {
  it('application_settings is never used to store credentials', async () => {
    const ddl = readFileSync('src/lib/db/schema.sql', 'utf8');
    expect(ddl).toMatch(/API keys and tokens live exclusively in\s*--\s*environment variables/i);
    const rows = await db.all('SELECT key FROM application_settings');
    expect(rows).toHaveLength(0);
  });
});
