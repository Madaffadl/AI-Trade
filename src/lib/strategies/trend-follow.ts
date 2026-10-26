import { at } from '@/lib/indicators';
import type { AssetClass, MarketRegime, Timeframe } from '@/lib/market/types';
import type { Strategy, StrategyContext, StrategyOutput, RuleOutcome } from './types';
import { fmt, strengthFromRules, describeExits, describeFailures } from './types';

/**
 * Strategy: Trend-following pullback entry (trend_follow_ema v1.0.0)
 *
 * Idea: in a confirmed uptrend, enter after price pulls back toward the fast EMA
 * and then resumes, rather than chasing an extended move.
 *
 * ENTRY (all must hold on the latest CLOSED bar):
 *   T1  EMA(fast) > EMA(slow)                      - trend direction
 *   T2  close > EMA(slow)                          - price respects the trend
 *   T3  the pullback touched EMA(fast) within the last `pullbackLookback` bars
 *   T4  close > previous bar's high                - resumption trigger
 *   T5  RSI > rsiFloor and < rsiCeiling            - momentum present, not exhausted
 *   T6  MACD histogram > 0                         - momentum confirmation
 *   T7  relative volume >= volumeFactor            - SKIPPED when volume is unavailable
 *
 * EXIT (evaluated only when a prior BUY is still open):
 *   X1  close < EMA(fast)                          - trend structure broken
 *   X2  MACD histogram < 0 for two consecutive bars
 *   X3  price reached take-profit 1
 *
 * STOP: entry - atrMultiplier * ATR, but never looser than the recent swing low.
 * TARGETS: fixed R multiples of the stop distance.
 *
 * This is a CANDIDATE strategy. It has not been shown to be profitable; see the
 * Strategy Evaluation page for its actual measured performance.
 */
export class TrendFollowStrategy implements Strategy {
  readonly id = 'trend_follow_ema';
  readonly version = '1.0.0';
  readonly name = 'Trend-following pullback (EMA + MACD)';
  readonly description =
    'Buys a pullback to the fast EMA inside a confirmed uptrend, confirmed by a resumption bar, RSI and MACD.';
  readonly assetClasses: AssetClass[] = ['crypto', 'stock'];
  readonly timeframes: Timeframe[] = ['15m', '1h', '4h', '1d'];
  readonly eligibleRegimes: MarketRegime[] = ['uptrend', 'low_volatility'];
  readonly warmupBars = 120;
  readonly evaluationHorizonBars = 20;
  readonly parameters = {
    fastPeriod: 20,
    slowPeriod: 50,
    rsiFloor: 50,
    rsiCeiling: 75,
    atrMultiplier: 1.5,
    pullbackLookback: 6,
    volumeFactor: 1.0,
    target1R: 1.5,
    target2R: 3,
  };

  evaluate(ctx: StrategyContext): StrategyOutput {
    const { bars, indicators: ind } = ctx;
    const i = bars.length - 1;
    const bar = bars[i];
    const prev = bars[i - 1];

    if (!bar || !prev || bars.length < this.warmupBars) {
      return {
        action: 'WAIT',
        strength: 'insufficient',
        rules: [],
        risks: [],
        invalidation: [],
        levels: null,
        summary: `Insufficient history: ${bars.length} closed bars, ${this.warmupBars} required.`,
      };
    }

    const emaFast = at(ind.emaFast, i);
    const emaSlow = at(ind.emaSlow, i);
    const rsiNow = at(ind.rsi, i);
    const hist = at(ind.macdHistogram, i);
    const histPrev = at(ind.macdHistogram, i - 1);
    const atrNow = at(ind.atr, i);
    const relVol = at(ind.volume.relativeVolume, i);

    // ---- Exit branch: an earlier BUY from this strategy is still open. ----
    if (ctx.hasOpenPosition) {
      const exitRules: RuleOutcome[] = [
        {
          id: 'X1',
          description: 'Close fell below the fast EMA (trend structure broken)',
          passed: emaFast !== null && bar.close < emaFast,
          detail: `close ${fmt(bar.close)} vs EMA${this.parameters.fastPeriod} ${fmt(emaFast)}`,
        },
        {
          id: 'X2',
          description: 'MACD histogram negative on two consecutive bars',
          passed: hist !== null && histPrev !== null && hist < 0 && histPrev < 0,
          detail: `histogram ${fmt(hist, 4)} / previous ${fmt(histPrev, 4)}`,
        },
        {
          id: 'X3',
          description: 'Price reached the first take-profit target',
          passed: ctx.openTarget !== null && bar.high >= ctx.openTarget,
          detail: ctx.openTarget === null ? 'no recorded target' : `high ${fmt(bar.high)} vs target ${fmt(ctx.openTarget)}`,
        },
      ];
      const anyExit = exitRules.some((r) => r.passed);
      return {
        action: anyExit ? 'SELL' : 'HOLD',
        strength: anyExit ? 'moderate' : 'moderate',
        rules: exitRules,
        risks: anyExit
          ? ['SELL here means exit or reduce an existing long. It is not a short-selling signal.']
          : ['Holding keeps the original stop-loss in force; the thesis still depends on the trend remaining intact.'],
        invalidation: [
          ctx.openStopLoss !== null
            ? `A close below the recorded stop-loss ${fmt(ctx.openStopLoss)} invalidates the position.`
            : 'No stop-loss was recorded for the open position.',
        ],
        levels: null,
        summary: anyExit
          ? describeExits(exitRules)
          : 'No qualifying exit condition on the latest closed bar; the position continues to meet its hold criteria.',
      };
    }

    // ---- Entry branch ----
    if (!this.eligibleRegimes.includes(ctx.regime)) {
      return {
        action: 'WAIT',
        strength: 'insufficient',
        rules: [
          {
            id: 'R0',
            description: 'Market regime permits a trend-following entry',
            passed: false,
            detail: `regime is "${ctx.regime}"; this strategy only enters in ${this.eligibleRegimes.join(' or ')}`,
          },
        ],
        risks: [],
        invalidation: [],
        levels: null,
        summary: `Regime "${ctx.regime}" is outside this strategy's eligible regimes.`,
      };
    }

    const lookback = this.parameters.pullbackLookback;
    let touchedFastEma = false;
    for (let j = Math.max(0, i - lookback); j <= i; j++) {
      const e = at(ind.emaFast, j);
      const b = bars[j];
      if (e !== null && b && b.low <= e) {
        touchedFastEma = true;
        break;
      }
    }

    const rules: RuleOutcome[] = [
      {
        id: 'T1',
        description: 'Fast EMA above slow EMA',
        passed: emaFast !== null && emaSlow !== null && emaFast > emaSlow,
        detail: `EMA${this.parameters.fastPeriod} ${fmt(emaFast)} vs EMA${this.parameters.slowPeriod} ${fmt(emaSlow)}`,
      },
      {
        id: 'T2',
        description: 'Close above the slow EMA',
        passed: emaSlow !== null && bar.close > emaSlow,
        detail: `close ${fmt(bar.close)} vs EMA${this.parameters.slowPeriod} ${fmt(emaSlow)}`,
      },
      {
        id: 'T3',
        description: `Pullback touched the fast EMA within ${lookback} bars`,
        passed: touchedFastEma,
        detail: touchedFastEma ? 'a bar low reached the fast EMA' : 'no pullback to the fast EMA in the window',
      },
      {
        id: 'T4',
        description: "Close above the previous bar's high (resumption trigger)",
        passed: bar.close > prev.high,
        detail: `close ${fmt(bar.close)} vs previous high ${fmt(prev.high)}`,
      },
      {
        id: 'T5',
        description: `RSI between ${this.parameters.rsiFloor} and ${this.parameters.rsiCeiling}`,
        passed: rsiNow !== null && rsiNow > this.parameters.rsiFloor && rsiNow < this.parameters.rsiCeiling,
        detail: `RSI ${fmt(rsiNow)}`,
      },
      {
        id: 'T6',
        description: 'MACD histogram positive',
        passed: hist !== null && hist > 0,
        detail: `histogram ${fmt(hist, 4)}`,
      },
      {
        id: 'T7',
        description: `Relative volume at least ${this.parameters.volumeFactor}x its 20-bar average`,
        passed: relVol !== null && relVol >= this.parameters.volumeFactor,
        detail: ind.volume.unavailable
          ? 'provider supplies no volume for this series - rule skipped, not assumed to pass'
          : `relative volume ${fmt(relVol)}`,
        skipped: ind.volume.unavailable || relVol === null,
      },
    ];

    const mandatory = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
    const allMandatoryPass = rules.filter((r) => mandatory.includes(r.id)).every((r) => r.passed);

    if (!allMandatoryPass || atrNow === null || emaFast === null) {
      const failedRules = rules.filter((r) => mandatory.includes(r.id) && !r.passed);
      return {
        action: 'WAIT',
        strength: 'insufficient',
        rules,
        risks: [],
        invalidation: [],
        levels: null,
        summary:
          atrNow === null
            ? 'ATR is not yet computable, so no stop distance can be derived.'
            : `Entry conditions not met — ${describeFailures(failedRules)}.`,
      };
    }

    const entry = bar.close;
    const atrStop = entry - this.parameters.atrMultiplier * atrNow;
    // Never place the stop above a recent swing low; use the tighter of the two
    // only when the swing low is still below the entry.
    const swingLow = ind.support;
    const stopLoss = swingLow !== null && swingLow < entry ? Math.min(atrStop, swingLow * 0.999) : atrStop;
    const riskPerUnit = entry - stopLoss;

    if (riskPerUnit <= 0) {
      return {
        action: 'WAIT',
        strength: 'insufficient',
        rules,
        risks: [],
        invalidation: [],
        levels: null,
        summary: 'Derived stop-loss is not below the entry price; no valid risk can be defined.',
      };
    }

    return {
      action: 'BUY',
      strength: strengthFromRules(rules),
      rules,
      risks: [
        'A trend-following entry fails when the trend ends; pullback entries are especially exposed to trend exhaustion.',
        ind.volume.unavailable
          ? 'Volume confirmation was unavailable for this data source, so one confirmation is missing.'
          : 'Volume confirmation was evaluated.',
        `Stop distance is ${fmt((riskPerUnit / entry) * 100)}% of price; a gap through the stop would lose more than planned.`,
      ],
      invalidation: [
        `A closed bar below ${fmt(stopLoss)} invalidates this setup.`,
        `A close back below EMA${this.parameters.slowPeriod} (${fmt(emaSlow)}) invalidates the trend premise.`,
        'A MACD histogram crossing back below zero removes the momentum confirmation.',
      ],
      levels: {
        entryLow: Math.min(entry, prev.high),
        entryHigh: entry * 1.002,
        stopLoss,
        takeProfit1: entry + this.parameters.target1R * riskPerUnit,
        takeProfit2: entry + this.parameters.target2R * riskPerUnit,
      },
      summary: `Uptrend pullback completed and resumed: close ${fmt(bar.close)} cleared the prior bar high ${fmt(prev.high)} with RSI ${fmt(rsiNow)} and a positive MACD histogram.`,
    };
  }
}
