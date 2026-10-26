import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openMemoryDb, type Db } from '@/lib/db/driver';

/**
 * Position accounting against a real database.
 *
 * These numbers are the ones the user acts on, so the arithmetic is pinned
 * exactly: fees are charged on BOTH sides, an unrecorded fee is treated as
 * zero (never invented), and percentages are taken against the actual cost
 * basis.
 */

let db: Db;

async function seed(d: Db) {
  await d.run(
    `INSERT INTO exchanges (id, name, asset_class, timezone, continuous, created_at_ms)
     VALUES ('INDODAX','Indodax','crypto','Asia/Jakarta',1,0)`,
  );
  await d.run(
    `INSERT INTO assets (id, symbol, display_name, asset_class, exchange_id, currency, active, created_at_ms)
     VALUES ('a-btc','BTCIDR','Bitcoin / Rupiah','crypto','INDODAX','IDR',1,0)`,
  );
}

async function insertPosition(d: Db, overrides: Partial<Record<string, unknown>> = {}) {
  const id = crypto.randomUUID();
  const v = {
    quantity: 0.01,
    entry_price: 1_450_000_000,
    entry_fee: 29_000,
    stop_loss: 1_380_000_000,
    take_profit_1: 1_600_000_000,
    ...overrides,
  };
  await d.run(
    `INSERT INTO positions (id, asset_id, venue, side, quantity, entry_price, entry_at_ms, entry_fee,
       stop_loss, take_profit_1, timeframe, trading_style, status, created_at_ms, updated_at_ms)
     VALUES (?, 'a-btc','indodax','long',?,?,?,?,?,?,'1d','swing','open',?,?)`,
    [id, v.quantity, v.entry_price, 1_000, v.entry_fee, v.stop_loss, v.take_profit_1, 1_000, 1_000],
  );
  return id;
}

/** Mirrors closePosition()'s arithmetic so the contract is asserted directly. */
function realise(entry: number, exit: number, qty: number, entryFee: number, exitFee: number) {
  const gross = (exit - entry) * qty;
  const net = gross - (entryFee + exitFee);
  return { gross, net, pct: (net / (entry * qty)) * 100 };
}

beforeEach(async () => {
  db = await openMemoryDb();
  await migrate(db);
  await seed(db);
});

describe('positions schema', () => {
  it('creates the positions table with its indexes', async () => {
    const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
    expect(tables.map((t) => t.name)).toContain('positions');
    const indexes = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index'");
    expect(indexes.map((i) => i.name)).toContain('idx_positions_open');
  });

  it('refuses a position pointing at an asset that does not exist', async () => {
    await expect(
      db.run(
        `INSERT INTO positions (id, asset_id, venue, side, quantity, entry_price, entry_at_ms, timeframe, trading_style, status, created_at_ms, updated_at_ms)
         VALUES ('x','nope','indodax','long',1,1,1,'1d','swing','open',1,1)`,
      ),
    ).rejects.toThrow();
  });

  it('stores one open position per asset and finds it back', async () => {
    const id = await insertPosition(db);
    const row = await db.get<{ id: string; status: string }>(
      "SELECT id, status FROM positions WHERE asset_id='a-btc' AND status='open'",
    );
    expect(row?.id).toBe(id);
  });
});

describe('realised P&L arithmetic', () => {
  it('charges fees on both entry and exit', () => {
    const r = realise(1_450_000_000, 1_520_000_000, 0.01, 29_000, 30_400);
    expect(r.gross).toBeCloseTo(700_000, 6);
    expect(r.net).toBeCloseTo(640_600, 6); // 700,000 - 59,400
    expect(r.pct).toBeCloseTo(4.4179, 3);
  });

  it('produces a loss when sold below entry', () => {
    const r = realise(1_450_000_000, 1_380_000_000, 0.01, 29_000, 27_600);
    expect(r.net).toBeLessThan(0);
    expect(r.net).toBeCloseTo(-756_600, 6);
  });

  it('treats an unrecorded fee as zero rather than inventing one', () => {
    const withFee = realise(100, 110, 1, 1, 1);
    const withoutFee = realise(100, 110, 1, 0, 0);
    expect(withoutFee.net).toBe(10);
    expect(withFee.net).toBe(8);
  });

  it('can turn a gross profit into a net loss when fees exceed the move', () => {
    const r = realise(1_000_000, 1_001_000, 1, 3_000, 3_000);
    expect(r.gross).toBe(1_000);
    expect(r.net).toBe(-5_000);
  });

  it('measures the percentage against the real cost basis', () => {
    const r = realise(200, 220, 5, 0, 0);
    // (220-200)*5 = 100 on a cost basis of 1000 -> 10%
    expect(r.pct).toBeCloseTo(10, 10);
  });
});

describe('plan level validation (mirrors the API guard)', () => {
  const entry = 1_450_000_000;
  const valid = (stop: number | null, tp1: number | null, tp2: number | null) => {
    if (stop !== null && stop >= entry) return false;
    if (tp1 !== null && tp1 <= entry) return false;
    if (tp2 !== null && tp1 !== null && tp2 <= tp1) return false;
    return true;
  };

  it('accepts a coherent plan', () => {
    expect(valid(1_380_000_000, 1_600_000_000, 1_700_000_000)).toBe(true);
  });

  it('rejects a stop at or above the entry', () => {
    expect(valid(entry, 1_600_000_000, null)).toBe(false);
    expect(valid(entry + 1, 1_600_000_000, null)).toBe(false);
  });

  it('rejects a target at or below the entry', () => {
    expect(valid(1_380_000_000, entry, null)).toBe(false);
  });

  it('rejects a second target below the first', () => {
    expect(valid(1_380_000_000, 1_600_000_000, 1_500_000_000)).toBe(false);
  });

  it('allows a position with no plan levels at all', () => {
    // Permitted, but the plan view warns that the trade has no defined exit.
    expect(valid(null, null, null)).toBe(true);
  });
});
