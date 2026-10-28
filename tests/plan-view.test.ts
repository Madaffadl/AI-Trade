import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { actionLine, PlanFacts, StateBadge, WhySection } from '@/components/plan/plan-view';
import { formatIdr, formatIdrSigned, formatWib } from '@/lib/format';
import { en } from '@/lib/i18n/en';
import { id } from '@/lib/i18n/id';
import { buildTradePlan } from '@/lib/plan/build';
import { buildCostModel } from '@/lib/plan/costs';

/**
 * The plan screen renders every number a trader acts on. Live Indodax data
 * cannot be relied on to produce a BUY on test day, so these render the
 * components to HTML from a synthetic plan.
 */

const HOUR = 3_600_000;
const plan = buildTradePlan({
  assetId: 'a1', symbol: 'BTCIDR', description: 'BTC/IDR',
  strategy: { id: 'trend_follow_ema', version: '1.0.0', name: 'Trend', horizonBars: 20 },
  timeframe: '1h', contextTimeframe: '4h', kind: 'triggered',
  signalBar: { openTimeMs: 0, closeTimeMs: HOUR },
  referenceEntry: 1_000_000, plannedEntry: 1_000_000, entryLow: 990_000, stopLoss: 950_000, takeProfit1: 1_100_000, takeProfit2: 1_200_000,
  trigger: null, atr: 20_000,
  context: { timeframe: '4h', up: true, strength: 0.5, close: 1, emaFast: 1, emaSlow: 1 },
  costs: buildCostModel({ takerFeePercent: 0.2, spreadPercent: 0.1, sellTaxPercent: 0.21, otherFeePercentPerSide: 0.0111 }),
  capital: { usableIdr: 1_000_000, cashAvailableIdr: 1_000_000 },
  settings: { riskPercent: 1, maxAllocationPercent: 50, minNetRiskReward: 1.5 },
  pair: { quantityIncrement: 1e-8, minOrderIdr: 10_000 },
  rules: [{ id: 'T1', description: 'Fast EMA above slow EMA', passed: true, detail: 'EMA20 1 vs EMA50 0.9' }],
  risks: ['Trend can end.'], invalidation: ['Close below the stop.'], summary: '',
});

describe('plan view', () => {
  it('shows entry, stop, targets, IDR amount, loss, profit and the sell-by time', () => {
    const now = Date.UTC(2026, 9, 29, 3);
    const html = renderToStaticMarkup(createElement(PlanFacts, { plan, t: id, now }));
    for (const text of [
      formatIdr(plan.entry.planned),
      formatIdr(plan.stopLoss),
      formatIdr(plan.takeProfit1),
      formatIdr(plan.sizing.notionalIdr),
      formatIdrSigned(-plan.sizing.lossAtStopIdr),
      formatIdrSigned(plan.outcome.netProfitTp1Idr),
      'Jual paling lambat',
      '20 jam',
      formatWib(now + 20 * HOUR),
    ]) {
      expect(html).toContain(text.replace(/&/g, '&amp;'));
    }
    // Losses carry the ▼ glyph, gains ▲ - colour is never the only cue.
    expect(html).toContain('▼');
    expect(html).toContain('▲');
  });

  it('tells the user exactly what to do for each state', () => {
    expect(actionLine(id, plan, 'BUY_NOW', 'actionable')).toBe(`Beli sekarang di harga ${formatIdr(plan.entry.max)} atau lebih rendah.`);
    expect(actionLine(en, plan, 'WAIT_FOR_ENTRY', 'above_max_entry')).toContain('do not chase');
    const pending = { ...plan, kind: 'pending' as const, trigger: { price: 1_010_000, requiresVolume: true } };
    expect(actionLine(id, pending, 'WAIT_FOR_ENTRY', 'awaiting_trigger')).toBe(
      `Beli hanya jika candle 1 jam DITUTUP di atas ${formatIdr(1_010_000)}. Candle itu juga perlu volume minimal 1,5× rata-rata 20 candle.`,
    );
    expect(actionLine(id, plan, 'NOT_ELIGIBLE', 'not_eligible')).toBeNull();
  });

  it('labels states in words and keeps the reasons one click away', () => {
    expect(renderToStaticMarkup(createElement(StateBadge, { state: 'BUY_NOW', t: id }))).toContain('Beli sekarang');
    const why = renderToStaticMarkup(createElement(WhySection, { plan, t: id }));
    expect(why).toContain('<details');
    expect(why).toContain('PASS');
    expect(why).toContain('Tren timeframe lebih besar (4 jam): naik');
  });

  it('formats Rupiah the Indonesian way, keeping precision for micro-priced coins', () => {
    expect(formatIdr(1_465_298_000)).toBe('Rp1.465.298.000');
    expect(formatIdr(0.1234567)).toBe('Rp0,1235');
    expect(formatIdrSigned(-12_500)).toBe('▼ −Rp12.500');
    expect(formatIdr(null)).toBe('—');
  });
});
