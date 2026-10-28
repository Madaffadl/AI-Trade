import { afterEach, describe, expect, it } from 'vitest';
import { cleanSymbol, indodaxTickerId, parsePairs, parseTickerAll, symbolFromTickerKey, type IndodaxPairMeta } from '@/lib/indodax/api';
import { selectUniverse, spreadPercent, type UniverseOptions } from '@/lib/indodax/universe';
import { buildCostModel, costPerUnit, entryCostPercent, exitCostPercent, netPnl, roundTripCostPercent } from '@/lib/plan/costs';
import { defaultTradingSettings, resolveTradingSettings, TradingSettingsUpdate, usableCapital } from '@/lib/settings/trading';
import { migrate, openMemoryDb } from '@/lib/db/driver';
import { MIGRATIONS, runMigrations } from '@/lib/db/migrations';
import { resetEnvCache } from '@/lib/config/env';

/** Indodax data layer, cost model, trading settings and migrations - no network. */

describe('Indodax symbols', () => {
  it('keeps digits, which are part of real pair names', () => {
    expect(cleanSymbol('1inch-idr')).toBe('1INCHIDR');
    expect(indodaxTickerId('1INCHIDR')).toBe('1inch_idr');
    expect(indodaxTickerId('API3IDR')).toBe('api3_idr');
    expect(indodaxTickerId('BTCIDR')).toBe('btc_idr');
    expect(symbolFromTickerKey('w3s_idr')).toBe('W3SIDR');
  });
});

describe('ticker_all parsing', () => {
  it('maps bid/ask/volume and drops rows it cannot trust', () => {
    const rows = parseTickerAll({
      tickers: {
        btc_idr: { last: '1465298000', buy: '1465000000', sell: '1467000000', high: '1', low: '1', vol_idr: '24560752552', server_time: 1793136000 },
        bad_idr: { last: 'n/a', buy: '1', sell: '2' },
        eth_usdt: { last: '2500', buy: '2499', sell: '2501', vol_usdt: '100' },
      },
    });
    expect(rows.map((r) => r.symbol)).toEqual(['BTCIDR', 'ETHUSDT']);
    expect(rows[0]).toMatchObject({ bid: 1_465_000_000, ask: 1_467_000_000, volumeIdr: 24_560_752_552, serverTimeMs: 1_793_136_000_000 });
    expect(rows[1]!.volumeIdr).toBeNull();
  });

  it('refuses a payload without tickers', () => {
    expect(() => parseTickerAll({})).toThrow(/no tickers/);
  });
});

describe('pair rules parsing', () => {
  it('reads fees, increments and the tradable flag', () => {
    const [p, halted] = parsePairs([
      {
        symbol: 'BTCIDR', ticker_id: 'btc_idr', description: 'BTC/IDR', base_currency: 'idr', traded_currency_unit: 'BTC',
        trade_fee_percent_taker: 0.2, trade_fee_percent_maker: 0.1, quantity_increment: 1e-8,
        trade_min_base_currency: 10000, trade_min_traded_currency: 0.00000682, price_precision: 1000,
        is_maintenance: 0, is_market_suspended: 0,
      },
      { symbol: 'XYZIDR', base_currency: 'idr', is_maintenance: 1 },
    ]);
    expect(p).toMatchObject({ quote: 'IDR', asset: 'BTC', takerFeePct: 0.2, quantityIncrement: 1e-8, minOrderValue: 10000, priceIncrement: 1000, tradable: true });
    expect(halted!.tradable).toBe(false);
    expect(halted!.takerFeePct).toBeNull();
  });
});

function meta(symbol: string, over: Partial<IndodaxPairMeta> = {}): IndodaxPairMeta {
  return {
    symbol, tickerId: indodaxTickerId(symbol), description: symbol, asset: symbol.slice(0, -3), quote: 'IDR',
    takerFeePct: 0.2, makerFeePct: 0.1, quantityIncrement: 1e-8, minOrderValue: 10_000, minQuantity: null,
    priceIncrement: 1, tradable: true, ...over,
  };
}

const ticker = (symbol: string, volumeIdr: number, bid = 99.9, ask = 100.1) => ({
  symbol, last: 100, bid, ask, high: null, low: null, volumeIdr, serverTimeMs: null,
});

describe('universe selection', () => {
  const opts: UniverseOptions = { minVolumeIdr: 1e9, maxSpreadPercent: 0.5, maxPairs: 3, alwaysInclude: ['BTCIDR', 'ETHIDR'] };

  it('filters on execution quality, never on price direction', () => {
    const tickers = [
      ticker('BTCIDR', 2e10), ticker('ETHIDR', 5e8), ticker('SOLIDR', 8e9), ticker('USDTIDR', 9e10),
      ticker('THINIDR', 1e8), ticker('WIDEIDR', 5e9, 95, 105), ticker('HALTIDR', 5e9), ticker('NOMETAIDR', 5e9),
      ticker('ETHUSDT', 5e9),
    ];
    const m = new Map(
      ['BTCIDR', 'ETHIDR', 'SOLIDR', 'USDTIDR', 'THINIDR', 'WIDEIDR'].map((s) => [s, meta(s)] as const),
    );
    m.set('HALTIDR', meta('HALTIDR', { tradable: false }));
    m.set('ETHUSDT', meta('ETHUSDT', { quote: 'USDT' }));

    const { included, excluded } = selectUniverse(tickers, m, opts);
    expect(included.map((c) => c.symbol)).toEqual(['BTCIDR', 'ETHIDR', 'SOLIDR']);
    const why = Object.fromEntries(excluded.map((c) => [c.symbol, c.reason]));
    expect(why).toEqual({
      USDTIDR: 'pegged', THINIDR: 'low_volume', WIDEIDR: 'wide_spread', HALTIDR: 'not_tradable',
      NOMETAIDR: 'no_meta', ETHUSDT: 'not_idr',
    });
  });

  it('keeps BTC and ETH even when quiet, and cuts the rest by turnover', () => {
    const tickers = [ticker('BTCIDR', 1e3), ticker('ETHIDR', 1e3), ticker('AIDR', 3e9), ticker('BIDR', 9e9)];
    const m = new Map(['BTCIDR', 'ETHIDR', 'AIDR', 'BIDR'].map((s) => [s, meta(s)] as const));
    const { included, excluded } = selectUniverse(tickers, m, opts);
    expect(included.map((c) => c.symbol)).toEqual(['BTCIDR', 'ETHIDR', 'BIDR']);
    expect(excluded).toEqual([expect.objectContaining({ symbol: 'AIDR', reason: 'rank_cut' })]);
  });

  it('measures spread against the mid price and rejects a crossed or empty book', () => {
    expect(spreadPercent(99, 101)).toBeCloseTo(2, 10);
    expect(spreadPercent(0, 101)).toBeNull();
    expect(spreadPercent(102, 101)).toBeNull();
  });
});

describe('Indodax cost model', () => {
  const m = buildCostModel({ takerFeePercent: 0.2, spreadPercent: 0.2, sellTaxPercent: 0.21, otherFeePercentPerSide: 0.0111 });

  it('charges the sale tax on the exit side only', () => {
    expect(entryCostPercent(m)).toBeCloseTo(0.3111, 10);
    expect(exitCostPercent(m)).toBeCloseTo(0.5211, 10);
    expect(roundTripCostPercent(m)).toBeCloseTo(0.8322, 10);
  });

  it('turns a gross gain into the net result actually kept', () => {
    // 10 units, 100 -> 102: gross 20; costs 10 x (0.3111 + 0.5211 x 1.02) = 8.426...
    const c = costPerUnit(100, 102, m);
    expect(c.entry).toBeCloseTo(0.3111, 10);
    expect(c.exit).toBeCloseTo(0.531522, 10);
    expect(netPnl(100, 102, 10, m)).toBeCloseTo(20 - 10 * c.total, 10);
    // A 0.5% move is a LOSS after Indodax costs.
    expect(netPnl(100, 100.5, 10, m)).toBeLessThan(0);
  });
});

describe('trading settings', () => {
  afterEach(() => resetEnvCache());

  it('falls back field by field, so one bad value cannot disable the rest', () => {
    const d = defaultTradingSettings();
    const s = resolveTradingSettings({ riskPercent: 50, maxOpenPositions: 3, capitalIdr: 'lots' }, d);
    expect(s.riskPercent).toBe(d.riskPercent);
    expect(s.maxOpenPositions).toBe(3);
    expect(s.capitalIdr).toBe(d.capitalIdr);
    expect(resolveTradingSettings(null, d)).toEqual(d);
  });

  it('rejects unknown fields and out-of-range values in an update', () => {
    expect(TradingSettingsUpdate.safeParse({ riskPercent: 1 }).success).toBe(true);
    expect(TradingSettingsUpdate.safeParse({ riskPercent: 10 }).success).toBe(false);
    expect(TradingSettingsUpdate.safeParse({ leverage: 10 }).success).toBe(false);
  });

  it('keeps reserved capital out of what the engine may use', () => {
    expect(usableCapital({ capitalIdr: 1_000_000, reservedIdr: 200_000 })).toBe(800_000);
    expect(usableCapital({ capitalIdr: 100_000, reservedIdr: 200_000 })).toBe(0);
  });
});

describe('migrations', () => {
  it('apply once each, and re-running migrate is a no-op', async () => {
    const d = await openMemoryDb();
    const first = await migrate(d);
    expect(first.applied).toEqual(MIGRATIONS.map((m) => m.id));
    expect((await migrate(d)).applied).toEqual([]);
    const rows = await d.all<{ id: string }>('SELECT id FROM schema_migrations');
    expect(rows).toHaveLength(MIGRATIONS.length);
  });

  it('switch a stored English interface to Indonesian and clear mis-stored Indodax lot sizes', async () => {
    const d = await openMemoryDb();
    await migrate(d);
    await d.run(`INSERT INTO application_settings (key, value_json, updated_at_ms) VALUES ('display.locale', '"en"', 0)`);
    await d.run(`INSERT INTO exchanges (id, name, asset_class, timezone, continuous, created_at_ms) VALUES ('INDODAX','Indodax','crypto','Asia/Jakarta',1,0)`);
    await d.run(
      `INSERT INTO assets (id, symbol, display_name, asset_class, exchange_id, currency, lot_size, active, created_at_ms)
       VALUES ('a1','BTCIDR','BTC/IDR','crypto','INDODAX','IDR',0.00000682,1,0)`,
    );
    await d.run('DELETE FROM schema_migrations');
    await runMigrations(d);
    expect((await d.get<{ value_json: string }>(`SELECT value_json FROM application_settings WHERE key = 'display.locale'`))!.value_json).toBe('"id"');
    expect((await d.get<{ lot_size: number | null }>(`SELECT lot_size FROM assets WHERE id = 'a1'`))!.lot_size).toBeNull();
  });
});
