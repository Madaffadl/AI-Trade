import { describe, expect, it } from 'vitest';
import { defaultCostAssumptions } from '@/lib/signals/risk';
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

describe('evaluation cost assumptions', () => {
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
