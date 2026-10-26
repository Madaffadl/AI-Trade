import { describe, expect, it } from 'vitest';
import { computeRisk, defaultCostAssumptions, aggregateOpenRisk } from '@/lib/signals/risk';
import { classifyRegime } from '@/lib/signals/regime';
import { buildIndicators, STRATEGIES } from '@/lib/strategies';
import { strengthFromRules } from '@/lib/strategies/types';
import type { Candle } from '@/lib/market/types';
import { TIMEFRAME_MS } from '@/lib/market/types';

const DAY = TIMEFRAME_MS['1d'];

/** Deterministic synthetic series builder - TEST FIXTURES ONLY, never used in the app. */
function series(prices: number[], opts: { volume?: number | null } = {}): Candle[] {
  return prices.map((p, i) => ({
    openTimeMs: i * DAY,
    closeTimeMs: (i + 1) * DAY,
    open: p * 0.995,
    high: p * 1.01,
    low: p * 0.99,
    close: p,
    volume: opts.volume === undefined ? 1000 : opts.volume,
    isPartial: false,
  }));
}

const asset = { tickSize: null, lotSize: null, minNotional: null, currency: 'USD', assetClass: 'crypto' as const };

describe('computeRisk', () => {
  const base = {
    entry: 100,
    stop: 95,
    targets: [110, 120],
    accountEquity: 10_000,
    riskPercentPerTrade: 1,
    feeBps: 10,
    slippageBps: 5,
    asset,
    direction: 'long' as const,
  };

  it('computes position size from the risk budget and stop distance', () => {
    const r = computeRisk(base);
    expect(r.ok).toBe(true);
    expect(r.riskPerUnit).toBeCloseTo(5, 10);
    // 1% of 10,000 = 100 risk budget; 100 / 5 = 20 units.
    expect(r.positionSize).toBeCloseTo(20, 10);
    expect(r.riskAmount).toBeCloseTo(100, 10);
    expect(r.stopDistancePct).toBeCloseTo(5, 10);
  });

  it('computes gross and net risk/reward, with net strictly worse', () => {
    const r = computeRisk(base);
    expect(r.riskReward).toBeCloseTo(2, 10); // (110-100)/5
    expect(r.riskRewardNet!).toBeLessThan(r.riskReward!);
  });

  it('refuses when the stop is not below the entry', () => {
    const r = computeRisk({ ...base, stop: 105 });
    expect(r.ok).toBe(false);
    expect(r.positionSize).toBeNull();
    expect(r.refusals.join(' ')).toMatch(/below the entry/i);
  });

  it('refuses when no target is above the entry', () => {
    const r = computeRisk({ ...base, targets: [90] });
    expect(r.ok).toBe(false);
    expect(r.refusals.join(' ')).toMatch(/take-profit/i);
  });

  it('refuses on invalid numeric inputs rather than returning a number', () => {
    expect(computeRisk({ ...base, entry: Number.NaN }).ok).toBe(false);
    expect(computeRisk({ ...base, accountEquity: 0 }).ok).toBe(false);
    expect(computeRisk({ ...base, riskPercentPerTrade: 0 }).ok).toBe(false);
  });

  it('discloses unknown lot and tick sizes instead of inventing them', () => {
    const r = computeRisk(base);
    expect(r.disclosures.join(' ')).toMatch(/lot\/step size for this asset is unknown/i);
    expect(r.disclosures.join(' ')).toMatch(/tick size is unknown/i);
  });

  it('rounds the position size down to a known lot size', () => {
    const r = computeRisk({ ...base, asset: { ...asset, lotSize: 3 } });
    // 20 units rounded down to a multiple of 3 = 18.
    expect(r.positionSize).toBeCloseTo(18, 10);
    expect(r.disclosures.join(' ')).not.toMatch(/lot\/step size for this asset is unknown/i);
  });

  it('refuses when the position falls below a known exchange minimum notional', () => {
    const r = computeRisk({ ...base, asset: { ...asset, minNotional: 100_000 } });
    expect(r.ok).toBe(false);
    expect(r.refusals.join(' ')).toMatch(/minimum/i);
  });

  it('charges costs against reward and adds them to potential loss', () => {
    const r = computeRisk(base);
    expect(r.potentialLoss!).toBeGreaterThan(r.riskAmount!);
  });

  it('aggregates open risk as a percentage of equity', () => {
    const agg = aggregateOpenRisk([100, 150, 50], 10_000);
    expect(agg.totalRisk).toBe(300);
    expect(agg.percentOfEquity).toBeCloseTo(3, 10);
  });

  it('uses different default cost assumptions per asset class', () => {
    expect(defaultCostAssumptions('crypto').feeBps).toBeGreaterThan(defaultCostAssumptions('stock').feeBps);
  });
});

describe('classifyRegime', () => {
  it('reports uncertain when there is not enough history', () => {
    expect(classifyRegime(series([1, 2, 3])).regime).toBe('uncertain');
  });

  it('detects an uptrend in a steadily rising series', () => {
    const prices = Array.from({ length: 120 }, (_, i) => 100 + i * 0.5);
    expect(classifyRegime(series(prices)).regime).toBe('uptrend');
  });

  it('detects a downtrend in a steadily falling series', () => {
    const prices = Array.from({ length: 120 }, (_, i) => 200 - i * 0.5);
    expect(classifyRegime(series(prices)).regime).toBe('downtrend');
  });

  it('is deterministic: identical input yields identical output', () => {
    const prices = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 7) * 8);
    const a = classifyRegime(series(prices));
    const b = classifyRegime(series(prices));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('always supplies the evidence behind the classification', () => {
    const prices = Array.from({ length: 120 }, (_, i) => 100 + i * 0.5);
    const r = classifyRegime(series(prices));
    expect(r.evidence.emaFast).not.toBeNull();
    expect(r.evidence.separationPct).not.toBeNull();
    expect(r.explanation.length).toBeGreaterThan(10);
  });
});

describe('strengthFromRules', () => {
  const rule = (passed: boolean, skipped = false) => ({ id: 'X', description: '', passed, detail: '', skipped });

  it('is insufficient when too few rules can be evaluated', () => {
    expect(strengthFromRules([rule(true), rule(true)])).toBe('insufficient');
  });

  it('excludes skipped rules from the denominator', () => {
    // 3 evaluable, all passing, but fewer than 5 -> moderate, not strong.
    expect(strengthFromRules([rule(true), rule(true), rule(true), rule(false, true)])).toBe('moderate');
  });

  it('only reports strong when all of at least five rules pass', () => {
    expect(strengthFromRules(Array(5).fill(rule(true)))).toBe('strong');
    expect(strengthFromRules([...Array(4).fill(rule(true)), rule(false)])).not.toBe('strong');
  });
});

describe('strategy contract', () => {
  const uptrend = series(Array.from({ length: 200 }, (_, i) => 100 + i * 0.4 + Math.sin(i / 5)));

  it('every strategy is a pure function of its inputs (reproducible)', () => {
    for (const strategy of STRATEGIES) {
      const ctx = {
        bars: uptrend,
        indicators: buildIndicators(uptrend),
        regime: 'uptrend' as const,
        timeframe: '1d' as const,
        assetClass: 'crypto' as const,
        hasOpenPosition: false,
        openEntryPrice: null,
        openStopLoss: null,
        openTarget: null,
      };
      const first = strategy.evaluate(ctx);
      const second = strategy.evaluate(ctx);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });

  it('refuses to act on insufficient history', () => {
    const short = series(Array.from({ length: 30 }, (_, i) => 100 + i));
    for (const strategy of STRATEGIES) {
      const out = strategy.evaluate({
        bars: short,
        indicators: buildIndicators(short),
        regime: 'uptrend',
        timeframe: '1d',
        assetClass: 'crypto',
        hasOpenPosition: false,
        openEntryPrice: null,
        openStopLoss: null,
        openTarget: null,
      });
      expect(out.action).toBe('WAIT');
      expect(out.levels).toBeNull();
      expect(out.summary).toMatch(/insufficient history/i);
    }
  });

  it('never produces an entry in a regime it is not eligible for', () => {
    for (const strategy of STRATEGIES) {
      const ineligible = (['uptrend', 'downtrend', 'sideways', 'high_volatility', 'low_volatility'] as const).find(
        (r) => !strategy.eligibleRegimes.includes(r),
      );
      if (!ineligible) continue;
      const out = strategy.evaluate({
        bars: uptrend,
        indicators: buildIndicators(uptrend),
        regime: ineligible,
        timeframe: '1d',
        assetClass: 'crypto',
        hasOpenPosition: false,
        openEntryPrice: null,
        openStopLoss: null,
        openTarget: null,
      });
      expect(out.action).toBe('WAIT');
    }
  });

  it('breakout refuses entirely when the provider supplies no volume', () => {
    const noVolume = series(
      Array.from({ length: 200 }, (_, i) => 100 + i * 0.4),
      { volume: null },
    );
    const breakout = STRATEGIES.find((s) => s.id === 'breakout_donchian')!;
    const out = breakout.evaluate({
      bars: noVolume,
      indicators: buildIndicators(noVolume),
      regime: 'uptrend',
      timeframe: '1d',
      assetClass: 'stock',
      hasOpenPosition: false,
      openEntryPrice: null,
      openStopLoss: null,
      openTarget: null,
    });
    expect(out.action).toBe('WAIT');
    expect(out.summary).toMatch(/volume confirmation/i);
  });

  it('returns SELL or HOLD - never BUY - when a position is already open', () => {
    for (const strategy of STRATEGIES) {
      const out = strategy.evaluate({
        bars: uptrend,
        indicators: buildIndicators(uptrend),
        regime: 'uptrend',
        timeframe: '1d',
        assetClass: 'crypto',
        hasOpenPosition: true,
        openEntryPrice: 100,
        openStopLoss: 90,
        openTarget: 130,
      });
      expect(['SELL', 'HOLD', 'WAIT']).toContain(out.action);
      expect(out.action).not.toBe('BUY');
    }
  });

  it('produces a stop strictly below entry and a target strictly above whenever it emits levels', () => {
    for (const strategy of STRATEGIES) {
      for (const regime of strategy.eligibleRegimes) {
        const out = strategy.evaluate({
          bars: uptrend,
          indicators: buildIndicators(uptrend),
          regime,
          timeframe: '1d',
          assetClass: 'crypto',
          hasOpenPosition: false,
          openEntryPrice: null,
          openStopLoss: null,
          openTarget: null,
        });
        if (!out.levels) continue;
        const entry = uptrend.at(-1)!.close;
        expect(out.levels.stopLoss).toBeLessThan(entry);
        expect(out.levels.takeProfit1).toBeGreaterThan(entry);
        expect(out.risks.length).toBeGreaterThan(0);
        expect(out.invalidation.length).toBeGreaterThan(0);
      }
    }
  });
});
