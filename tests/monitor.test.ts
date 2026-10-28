import { describe, expect, it } from 'vitest';
import { migrate, openMemoryDb } from '@/lib/db/driver';
import { en, id } from '@/lib/i18n';
import { release, tryAcquire } from '@/lib/jobs/lock';
import { intervalDue, latestScanSlot, scanDue } from '@/lib/jobs/schedule';
import { buyNowKey, cancelAlert, holdingAlert, setupAlert, simAlert, type SetupForAlert } from '@/lib/notifications/plan-alerts';
import { buildTradePlan, type PlanInput } from '@/lib/plan/build';
import { buildCostModel } from '@/lib/plan/costs';
import { decide } from '@/lib/plan/decision';
import { scanFreshness } from '@/lib/plan/states';
import type { TrendContext } from '@/lib/plan/types';
import { simEvents, type SimState } from '@/lib/sim/fills';

/**
 * Phase 6: the worker's timing, the live monitor's decision and freshness
 * rules, the alerts it raises, and the lock that keeps the scan and the
 * monitor from running at once.
 */

const MIN = 60_000;
const HOUR = 3_600_000;

describe('worker schedule', () => {
  const offset = 90_000;
  const hour = Date.UTC(2026, 9, 29, 10);

  it('places the scan 90 s after each hourly candle close', () => {
    expect(latestScanSlot(hour + offset, offset)).toBe(hour + offset);
    expect(latestScanSlot(hour + 30 * MIN, offset)).toBe(hour + offset);
    // Before this hour's slot, the latest slot is last hour's.
    expect(latestScanSlot(hour + 60_000, offset)).toBe(hour - HOUR + offset);
  });

  it('runs a scan once per slot, at start-up when none is recent, and retries a failed one after 5 min', () => {
    const now = hour + 10 * MIN;
    expect(scanDue(now, null, offset)).toBe(true);
    expect(scanDue(now, { startedAtMs: hour - 20 * MIN, failed: false }, offset)).toBe(true);
    expect(scanDue(now, { startedAtMs: hour + offset, failed: false }, offset)).toBe(false);
    // A scan started by "Refresh now" after the slot counts too.
    expect(scanDue(now, { startedAtMs: hour + 8 * MIN, failed: false }, offset)).toBe(false);
    expect(scanDue(now, { startedAtMs: hour + 6 * MIN, failed: true }, offset)).toBe(false);
    expect(scanDue(now, { startedAtMs: hour + 4 * MIN, failed: true }, offset)).toBe(true);
  });

  it('runs interval jobs when they never ran or the interval passed', () => {
    expect(intervalDue(1_000, null, 500)).toBe(true);
    expect(intervalDue(1_000, 600, 500)).toBe(false);
    expect(intervalDue(1_100, 600, 500)).toBe(true);
  });
});

describe('home decision', () => {
  const base = { pairsWithData: 10, dailyLossPercent: 0, maxDailyLossPercent: 3, openPositions: 0, maxOpenPositions: 2 };

  it('follows the best setup', () => {
    expect(decide({ ...base, topState: 'BUY_NOW' })).toBe('BUY_NOW');
    expect(decide({ ...base, topState: 'WAIT_FOR_ENTRY' })).toBe('WAIT_FOR_ENTRY');
    expect(decide({ ...base, topState: null })).toBe('NO_TRADE');
  });

  it('puts data, the daily loss limit and the position limit before any setup', () => {
    expect(decide({ ...base, pairsWithData: 0, topState: 'BUY_NOW' })).toBe('DATA_UNAVAILABLE');
    expect(decide({ ...base, dailyLossPercent: 3, topState: 'BUY_NOW' })).toBe('DAILY_STOP');
    expect(decide({ ...base, openPositions: 2, topState: 'BUY_NOW' })).toBe('POSITIONS_FULL');
  });
});

describe('scan freshness', () => {
  const scan = { id: 's1', finishedAtMs: 0 };

  it('counts prices from a later live check of the same scan', () => {
    const now = 40 * MIN;
    expect(scanFreshness(scan, null, now)).toMatchObject({ fresh: false, staleMinutes: 40 });
    expect(scanFreshness(scan, { scanId: 's1', checkedAtMs: now - MIN }, now)).toMatchObject({ fresh: true, pricesAtMs: now - MIN });
    // A check of a different scan says nothing about this one.
    expect(scanFreshness(scan, { scanId: 's0', checkedAtMs: now - MIN }, now).fresh).toBe(false);
  });

  it('stops acting on candles from a scan older than 75 minutes, even with live prices', () => {
    const now = 80 * MIN;
    expect(scanFreshness(scan, { scanId: 's1', checkedAtMs: now }, now)).toEqual({ fresh: false, pricesAtMs: now, staleMinutes: 80 });
  });
});

describe('paper-trade events', () => {
  const open: SimState = {
    status: 'pending_entry', entryKind: 'limit', entryMax: 101, stopLoss: 95, takeProfit1: 110, horizonMs: 20 * HOUR,
    expiresAtMs: 4 * HOUR, initialQuantity: null, quantity: null, entryPrice: null, entryAtMs: null, sellByMs: null,
    realizedPnlIdr: 0, exitPrice: null, exitAtMs: null, exitReason: null, fills: [],
  };
  const buy = { side: 'buy' as const, quantity: 10, price: 100, atMs: 1, source: 'ticker' as const, reason: 'limit', costIdr: 2 };
  const sell = { side: 'sell' as const, quantity: 10, price: 110, atMs: 2, source: 'ticker' as const, reason: 'tp1', costIdr: 5, pnlIdr: 93 };

  it('reports only what is new since the last check', () => {
    const filled = { ...open, status: 'open' as const, fills: [buy] };
    expect(simEvents(open, filled)).toEqual([{ kind: 'fill', index: 0, fill: buy }]);
    expect(simEvents(filled, filled)).toEqual([]);
    expect(simEvents(filled, { ...filled, status: 'closed', fills: [buy, sell] })).toEqual([{ kind: 'fill', index: 1, fill: sell }]);
    // A trade created already filled (auto-simulation at the ask).
    expect(simEvents(null, filled)).toHaveLength(1);
  });

  it('reports an order that expired unfilled, once', () => {
    const expired = { ...open, status: 'cancelled' as const, exitReason: 'expired' as const };
    expect(simEvents(open, expired)).toEqual([{ kind: 'expired' }]);
    expect(simEvents(expired, expired)).toEqual([]);
    expect(simEvents(open, { ...expired, exitReason: 'cancelled' })).toEqual([]);
  });

  it('turns them into alerts keyed per fill', () => {
    const trade = { id: 't1', asset_id: 'a1', plan: { description: 'TEST/IDR', symbol: 'TESTIDR' } };
    const bought = simAlert(id, trade, { kind: 'fill', index: 0, fill: buy });
    expect(bought).toMatchObject({ dedupeKey: 'sim:t1:fill:0', kind: 'simulation', title: 'Simulasi: beli TEST/IDR' });
    const sold = simAlert(id, trade, { kind: 'fill', index: 1, fill: sell });
    expect(sold.title).toBe('Simulasi: jual TEST/IDR — target 1');
    expect(sold.body).toContain('+Rp93');
    expect(simAlert(en, trade, { kind: 'expired' }).dedupeKey).toBe('sim:t1:expired');
  });
});

describe('setup alerts', () => {
  const costs = buildCostModel({ takerFeePercent: 0.2, spreadPercent: 0.2, sellTaxPercent: 0.21, otherFeePercentPerSide: 0.0111 });
  const up: TrendContext = { timeframe: '1d', up: true, strength: 0.6, close: 1, emaFast: 1, emaSlow: 1 };
  const input = (over: Partial<PlanInput> = {}): PlanInput => ({
    assetId: 'a1', symbol: 'TESTIDR', description: 'TEST/IDR',
    strategy: { id: 'trend_momentum', version: '1.0.0', name: 'Momentum', horizonBars: 30 },
    timeframe: '4h', contextTimeframe: '1d', kind: 'triggered',
    signalBar: { openTimeMs: 100 * 4 * HOUR, closeTimeMs: 101 * 4 * HOUR },
    referenceEntry: 100, plannedEntry: 100, entryLow: 99, stopLoss: 92, takeProfit1: 116, takeProfit2: 132,
    trigger: null, atr: 3, context: up, costs,
    capital: { usableIdr: 200_000, cashAvailableIdr: 200_000 },
    settings: { riskPercent: 1, maxAllocationPercent: 50, minNetRiskReward: 1.5 },
    pair: { quantityIncrement: 1e-8, minOrderIdr: 10_000 },
    rules: [], risks: [], invalidation: [], summary: '',
    ...over,
  });
  const setup = (over: Partial<SetupForAlert> = {}, plan: Partial<PlanInput> = {}): SetupForAlert => ({
    id: 'set1', asset_id: 'a1', state: 'BUY_NOW', state_reason: 'actionable', validation: 'experimental', signal_id: null,
    plan: buildTradePlan(input(plan)),
    ...over,
  });

  it('announces BUY NOW once per setup, with every number needed to act', () => {
    const a = setupAlert(id, setup())!;
    expect(a.dedupeKey).toBe(buyNowKey('set1'));
    expect(a.title).toBe('Bisa dibeli sekarang — eksperimental: TEST/IDR (4 jam)');
    expect(a.severity).toBe('info');
    expect(a.body).toContain('Beli sekarang di harga');
    expect(a.body).toMatch(/stop Rp92 \(−8\.00%\)/);
    expect(a.body).toContain('Jual paling lambat 120 jam');
    expect(a.body).toContain('Strategi eksperimental');
    const validated = setupAlert(id, setup({ validation: 'validated' }))!;
    expect(validated).toMatchObject({ title: 'BELI SEKARANG: TEST/IDR (4 jam)', severity: 'warning' });
    expect(validated.body).not.toContain('eksperimental');
  });

  it('announces a wait-for-trigger at most once per entry window of the same pair and strategy', () => {
    const pending = (bar: number) =>
      setupAlert(
        en,
        setup(
          { id: `p${bar}`, state: 'WAIT_FOR_ENTRY', state_reason: 'awaiting_trigger' },
          { kind: 'pending', trigger: { price: 100, requiresVolume: false }, signalBar: { openTimeMs: bar * 4 * HOUR, closeTimeMs: (bar + 1) * 4 * HOUR } },
        ),
      )!;
    expect(pending(300).title).toBe('Get ready: TEST/IDR (4-hour)');
    expect(pending(300).body).toContain('CLOSES above Rp100');
    // Bars 300-302 share a 3-bar window; bar 303 starts the next one.
    expect(pending(301).dedupeKey).toBe(pending(300).dedupeKey);
    expect(pending(302).dedupeKey).toBe(pending(300).dedupeKey);
    expect(pending(303).dedupeKey).not.toBe(pending(300).dedupeKey);
  });

  it('stays quiet for setups that are not actionable or only waiting for a pullback', () => {
    expect(setupAlert(en, setup({ state: 'WAIT_FOR_ENTRY', state_reason: 'above_max_entry' }))).toBeNull();
    expect(setupAlert(en, setup({ state: 'NOT_ELIGIBLE', state_reason: 'not_eligible' }))).toBeNull();
    expect(setupAlert(en, setup({ state: 'DATA_STALE', state_reason: 'stale_data' }))).toBeNull();
  });

  it('withdraws an announced setup that failed, with the reason', () => {
    const a = cancelAlert(id, setup({ state: 'INVALIDATED', state_reason: 'below_stop' }))!;
    expect(a.dedupeKey).toBe('setup:set1:INVALIDATED');
    expect(a.title).toBe('Jangan beli lagi: TEST/IDR (4 jam) — Batal');
    expect(a.body).toContain('turun ke stop');
    expect(cancelAlert(en, setup({ state: 'MISSED', state_reason: 'target_passed' }))!.body).toContain('do not chase');
    expect(cancelAlert(en, setup())).toBeNull();
  });
});

describe('holding alerts', () => {
  const holding = {
    id: 'pos1', asset_id: 'a1', symbol: 'TESTIDR', display_name: 'TEST/IDR', quantity: 10, entry_price: 100, entry_fee: 2,
    stop_loss: 95, take_profit_1: 110, sellByMs: 10 * HOUR,
  };

  it('raises the most urgent action only: stop, then target, then sell-by time', () => {
    const stop = holdingAlert(id, holding, 94, 11 * HOUR)!;
    expect(stop).toMatchObject({ dedupeKey: 'position_live_stop:pos1', severity: 'critical', title: 'JUAL — stop-loss tersentuh: TEST/IDR' });
    expect(stop.body).toContain('−Rp62'); // (94 - 100) x 10 - 2
    expect(holdingAlert(en, holding, 111, 11 * HOUR)!.dedupeKey).toBe('position_live_tp1:pos1');
    expect(holdingAlert(en, holding, 103, 11 * HOUR)!.dedupeKey).toBe('position_time:pos1');
    expect(holdingAlert(en, holding, 103, 9 * HOUR)).toBeNull();
    expect(holdingAlert(en, { ...holding, stop_loss: null, take_profit_1: null, sellByMs: null }, 1, 11 * HOUR)).toBeNull();
  });
});

describe('job lock', () => {
  it('lets one holder in at a time, releases only for its holder, and recovers from a dead process', async () => {
    const d = await openMemoryDb();
    await migrate(d);
    const first = await tryAcquire(d, 'market', 60_000, 1_000);
    expect(first).not.toBeNull();
    expect(await tryAcquire(d, 'market', 60_000, 2_000)).toBeNull();
    await release(d, 'market', 'someone-else');
    expect(await tryAcquire(d, 'market', 60_000, 3_000)).toBeNull();
    // The holder died without releasing: once its lease passes, the lock is taken over.
    expect(await tryAcquire(d, 'market', 60_000, 62_000)).not.toBeNull();
    const other = await tryAcquire(d, 'other', 60_000, 62_000);
    expect(other).not.toBeNull();
    await release(d, 'other', other!);
    expect(await tryAcquire(d, 'other', 60_000, 63_000)).not.toBeNull();
  });
});
