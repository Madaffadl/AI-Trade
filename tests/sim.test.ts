import { describe, expect, it } from 'vitest';
import { buildCostModel } from '@/lib/plan/costs';
import {
  checkExits,
  fillEntry,
  fillExit,
  realizedPnlPercent,
  replayCandles,
  simCosts,
  tryEntry,
  unrealizedPnl,
  type SimState,
} from '@/lib/sim/fills';
import type { Candle } from '@/lib/market/types';

/** Paper-trading fill rules: the numbers a simulation reports must be the numbers a real trade would get. */

const HOUR = 3_600_000;
const planCosts = buildCostModel({ takerFeePercent: 0.2, spreadPercent: 0.4, sellTaxPercent: 0.21, otherFeePercentPerSide: 0 });
const costs = simCosts(planCosts);

const pending: SimState = {
  status: 'pending_entry',
  entryKind: 'limit',
  entryMax: 101,
  stopLoss: 95,
  takeProfit1: 110,
  horizonMs: 20 * HOUR,
  expiresAtMs: 3 * HOUR,
  initialQuantity: null,
  quantity: null,
  entryPrice: null,
  entryAtMs: null,
  sellByMs: null,
  realizedPnlIdr: 0,
  exitPrice: null,
  exitAtMs: null,
  exitReason: null,
  fills: [],
};
const open = fillEntry(pending, 100, 10, 0, 'ticker', costs);
const q = (bid: number, ask: number, atMs = HOUR) => ({ bid, ask, atMs });

function bar(openTimeMs: number, o: number, h: number, l: number, c: number, isPartial = false): Candle {
  return { openTimeMs, closeTimeMs: openTimeMs + HOUR, open: o, high: h, low: l, close: c, volume: 1, isPartial };
}

describe('costs in simulation', () => {
  it('drops the spread from the cost model, because fills already use the real bid and ask', () => {
    expect(costs.halfSpreadPercent).toBe(0);
    expect(costs.buyFeePercent).toBe(0.2);
    expect(costs.sellTaxPercent).toBe(0.21);
  });

  it('charges fee on the buy, fee and tax on the sell', () => {
    const closed = fillExit(open, 110, HOUR, 'tp1', 'ticker', costs);
    // gross 10 x 10 = 100; buy cost 10 x 100 x 0.2% = 2; sell cost 10 x 110 x 0.41% = 4.51
    expect(closed.realizedPnlIdr).toBeCloseTo(100 - 2 - 4.51, 10);
    expect(closed).toMatchObject({ status: 'closed', exitPrice: 110, exitReason: 'tp1', quantity: 0 });
    expect(realizedPnlPercent(closed, costs)).toBeCloseTo((93.49 / 1002) * 100, 8);
  });
});

describe('entry', () => {
  const size = () => 10;

  it('fills a resting order at the ask once the ask is at or below the maximum entry', () => {
    expect(tryEntry(pending, q(101.5, 101.8), HOUR, size, costs).status).toBe('pending_entry');
    const filled = tryEntry(pending, q(100.6, 100.8), HOUR, size, costs);
    expect(filled).toMatchObject({ status: 'open', entryPrice: 100.8, quantity: 10, sellByMs: HOUR + 20 * HOUR });
  });

  it('expires an order that never filled inside the setup window', () => {
    expect(tryEntry(pending, q(99, 99.2), 4 * HOUR, size, costs)).toMatchObject({ status: 'cancelled', exitReason: 'expired' });
  });

  it('leaves a trigger order for the strategy to confirm on a closed candle', () => {
    expect(tryEntry({ ...pending, entryKind: 'trigger' }, q(99, 99.2), HOUR, size, costs).status).toBe('pending_entry');
  });

  it('does not open a position of zero size', () => {
    expect(tryEntry(pending, q(99, 99.2), HOUR, () => 0, costs).status).toBe('pending_entry');
  });
});

describe('live exits', () => {
  it('sells at the bid when the bid gaps through the stop - never at the stop price', () => {
    expect(checkExits(open, q(93, 93.2), HOUR, costs)).toMatchObject({ status: 'closed', exitReason: 'stop', exitPrice: 93 });
  });

  it('fills the target exactly at target 1', () => {
    expect(checkExits(open, q(112, 112.3), HOUR, costs)).toMatchObject({ exitReason: 'tp1', exitPrice: 110 });
  });

  it('sells at the bid once the sell-by time has passed', () => {
    expect(checkExits(open, q(103, 103.2), 21 * HOUR, costs)).toMatchObject({ exitReason: 'time', exitPrice: 103 });
  });

  it('holds while price is between stop and target before the deadline', () => {
    expect(checkExits(open, q(103, 103.2), 2 * HOUR, costs).status).toBe('open');
  });
});

describe('replaying candles missed while nobody was watching', () => {
  it('counts a stop and a target inside the same candle as the stop', () => {
    const r = replayCandles(open, [bar(HOUR, 100, 111, 94, 105)], HOUR, costs);
    expect(r).toMatchObject({ exitReason: 'stop', exitPrice: 95, exitAtMs: HOUR });
  });

  it('fills at the open when a candle opens through the stop', () => {
    expect(replayCandles(open, [bar(HOUR, 92, 96, 90, 93)], HOUR, costs)).toMatchObject({ exitReason: 'stop', exitPrice: 92 });
  });

  it('ignores the candle in progress at the last check and anything partial', () => {
    const candles = [bar(0, 100, 111, 99, 105), bar(HOUR, 100, 111, 99, 105, true)];
    expect(replayCandles(open, candles, 30 * 60_000, costs).status).toBe('open');
  });

  it('exits on time at the open of the first candle after the sell-by time', () => {
    const late = { ...open, sellByMs: 2 * HOUR };
    const r = replayCandles(late, [bar(HOUR, 101, 102, 100, 101), bar(2 * HOUR, 102, 103, 101, 102)], HOUR, costs);
    expect(r).toMatchObject({ exitReason: 'time', exitPrice: 102 });
  });
});

describe('partial closes and open results', () => {
  it('closes half, keeps the rest open, then reports the average exit', () => {
    const half = fillExit(open, 104, HOUR, 'manual', 'manual', costs, 5);
    expect(half).toMatchObject({ status: 'open', quantity: 5 });
    expect(half.realizedPnlIdr).toBeCloseTo(5 * 4 - 5 * 100 * 0.002 - 5 * 104 * 0.0041, 10);
    const all = fillExit(half, 108, 2 * HOUR, 'manual', 'manual', costs);
    expect(all).toMatchObject({ status: 'closed', quantity: 0, exitPrice: 106 });
  });

  it('values an open position as if sold at the mark, after costs', () => {
    expect(unrealizedPnl(open, 100, costs)).toBeCloseTo(-(10 * 100 * 0.002) - 10 * 100 * 0.0041, 10);
    expect(unrealizedPnl(pending, 100, costs)).toBeNull();
  });
});
