import { at } from '@/lib/indicators';
import type { AssetClass, MarketRegime, Timeframe } from '@/lib/market/types';
import type { RuleOutcome, Strategy, StrategyContext, StrategyOutput } from './types';
import { fmt, strengthFromRules, describeExits, describeFailures } from './types';

/**
 * Strategy: Donchian breakout with volume confirmation (breakout_donchian v1.0.0)
 *
 * Idea: enter when price closes above the highest high of the prior N bars, but
 * only when participation confirms the move. Breakouts on thin volume fail
 * often, so the volume rule is MANDATORY here - and if the data source supplies
 * no volume at all, this strategy refuses to produce an entry rather than
 * firing on half the evidence.
 *
 * ENTRY (all must hold on the latest CLOSED bar):
 *   B1  close > Donchian upper channel of the prior `channelPeriod` bars
 *   B2  the breakout bar closes in the upper third of its own range
 *   B3  relative volume >= volumeFactor   (MANDATORY - no volume, no signal)
 *   B4  close > EMA(slow)                 - not fighting the larger trend
 *   B5  ATR% within the workable band     - avoids dead and chaotic markets
 *
 * EXIT:
 *   X1  close back below the breakout level (failed breakout)
 *   X2  close below the Donchian lower channel
 *   X3  take-profit 1 reached
 *
 * STOP: the greater of (entry - atrMultiplier*ATR) and just under the breakout
 * level, so a clean failed breakout exits quickly.
 *
 * CANDIDATE strategy - unproven. See the Strategy Evaluation page.
 */
export class BreakoutStrategy implements Strategy {
  readonly id = 'breakout_donchian';
  readonly version = '1.0.0';
  readonly name = 'Donchian breakout with volume confirmation';
  readonly description =
    'Buys a close above the prior N-bar high when volume confirms participation and the larger trend is not opposed.';
  readonly assetClasses: AssetClass[] = ['crypto', 'stock'];
  readonly timeframes: Timeframe[] = ['15m', '1h', '4h', '1d'];
  readonly eligibleRegimes: MarketRegime[] = ['uptrend', 'sideways', 'high_volatility'];
  readonly warmupBars = 120;
  readonly evaluationHorizonBars = 20;
  readonly parameters = {
    channelPeriod: 20,
    slowPeriod: 50,
    volumeFactor: 1.5,
    atrMultiplier: 1.5,
    minAtrPct: 0.003,
    maxAtrPct: 0.08,
    closeStrength: 0.66,
    target1R: 2,
    target2R: 4,
  };

  evaluate(ctx: StrategyContext): StrategyOutput {
    const { bars, indicators: ind } = ctx;
    const i = bars.length - 1;
    const bar = bars[i];

    if (!bar || bars.length < this.warmupBars) {
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

    const channelUpper = at(ind.donchianUpper, i);
    const channelLower = at(ind.donchianLower, i);
    const emaSlow = at(ind.emaSlow, i);
    const atrNow = at(ind.atr, i);
    const relVol = at(ind.volume.relativeVolume, i);
    const atrPct = atrNow !== null && bar.close !== 0 ? atrNow / bar.close : null;

    if (ctx.hasOpenPosition) {
      const exitRules: RuleOutcome[] = [
        {
          id: 'X1',
          description: 'Close fell back below the breakout level (failed breakout)',
          passed: ctx.openEntryPrice !== null && bar.close < ctx.openEntryPrice,
          detail:
            ctx.openEntryPrice === null
              ? 'no recorded entry price'
              : `close ${fmt(bar.close)} vs breakout entry ${fmt(ctx.openEntryPrice)}`,
        },
        {
          id: 'X2',
          description: 'Close below the Donchian lower channel',
          passed: channelLower !== null && bar.close < channelLower,
          detail: `close ${fmt(bar.close)} vs lower channel ${fmt(channelLower)}`,
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
        strength: 'moderate',
        rules: exitRules,
        risks: anyExit ? ['SELL here means exit or reduce an existing long, not open a short.'] : [],
        invalidation: [
          ctx.openStopLoss !== null
            ? `A close below ${fmt(ctx.openStopLoss)} invalidates the position.`
            : 'No stop-loss was recorded for the open position.',
        ],
        levels: null,
        summary: anyExit
          ? describeExits(exitRules)
          : 'Breakout still holding above its level; no exit condition met.',
      };
    }

    if (!this.eligibleRegimes.includes(ctx.regime)) {
      return {
        action: 'WAIT',
        strength: 'insufficient',
        rules: [
          {
            id: 'R0',
            description: 'Market regime permits a breakout entry',
            passed: false,
            detail: `regime is "${ctx.regime}"; eligible regimes are ${this.eligibleRegimes.join(', ')}`,
          },
        ],
        risks: [],
        invalidation: [],
        levels: null,
        summary: `Regime "${ctx.regime}" is outside this strategy's eligible regimes.`,
      };
    }

    // Volume is mandatory here. Without it the strategy produces no entry at
    // all - it does not fall back to a weaker version of itself.
    if (ind.volume.unavailable || relVol === null) {
      return {
        action: 'WAIT',
        strength: 'insufficient',
        rules: [
          {
            id: 'B3',
            description: 'Volume confirmation is available',
            passed: false,
            skipped: true,
            detail: 'This data source supplies no per-bar volume, and this strategy requires volume confirmation.',
          },
        ],
        risks: [],
        invalidation: [],
        levels: null,
        summary:
          'Breakout entries require volume confirmation, which this data source cannot provide. No signal is generated.',
      };
    }

    const range = bar.high - bar.low;
    const closePosition = range > 0 ? (bar.close - bar.low) / range : 0;

    const rules: RuleOutcome[] = [
      {
        id: 'B1',
        description: `Close above the ${this.parameters.channelPeriod}-bar high`,
        passed: channelUpper !== null && bar.close > channelUpper,
        detail: `close ${fmt(bar.close)} vs channel high ${fmt(channelUpper)}`,
      },
      {
        id: 'B2',
        description: 'Breakout bar closes in the upper third of its range',
        passed: closePosition >= this.parameters.closeStrength,
        detail: `close sits at ${fmt(closePosition * 100, 1)}% of the bar range`,
      },
      {
        id: 'B3',
        description: `Relative volume at least ${this.parameters.volumeFactor}x the 20-bar average`,
        passed: relVol >= this.parameters.volumeFactor,
        detail: `relative volume ${fmt(relVol)}`,
      },
      {
        id: 'B4',
        description: 'Close above the slow EMA',
        passed: emaSlow !== null && bar.close > emaSlow,
        detail: `close ${fmt(bar.close)} vs EMA${this.parameters.slowPeriod} ${fmt(emaSlow)}`,
      },
      {
        id: 'B5',
        description: 'Volatility inside the workable band',
        passed:
          atrPct !== null && atrPct >= this.parameters.minAtrPct && atrPct <= this.parameters.maxAtrPct,
        detail: `ATR is ${fmt((atrPct ?? 0) * 100)}% of price (band ${(this.parameters.minAtrPct * 100).toFixed(2)}%-${(this.parameters.maxAtrPct * 100).toFixed(2)}%)`,
      },
    ];

    const allPass = rules.every((r) => r.passed);
    if (!allPass || atrNow === null || channelUpper === null) {
      return {
        action: 'WAIT',
        strength: 'insufficient',
        rules,
        risks: [],
        invalidation: [],
        levels: null,
        summary: `Breakout conditions not met — ${describeFailures(rules)}.`,
      };
    }

    const entry = bar.close;
    const atrStop = entry - this.parameters.atrMultiplier * atrNow;
    // A breakout that closes back under its level is already wrong, so the stop
    // is never placed further away than just below the breakout level.
    const stopLoss = Math.max(atrStop, channelUpper * 0.998);
    const riskPerUnit = entry - stopLoss;

    if (riskPerUnit <= 0) {
      return {
        action: 'WAIT',
        strength: 'insufficient',
        rules,
        risks: [],
        invalidation: [],
        levels: null,
        summary: 'Breakout level sits at or above the entry; no valid stop distance can be derived.',
      };
    }

    return {
      action: 'BUY',
      strength: strengthFromRules(rules),
      rules,
      risks: [
        'Breakouts frequently fail and reverse back into the prior range ("false breakout").',
        `Stop distance is only ${fmt((riskPerUnit / entry) * 100)}% of price, so normal noise can trigger it.`,
        'High relative volume can also mark exhaustion rather than continuation.',
      ],
      invalidation: [
        `A closed bar below the breakout level ${fmt(channelUpper)} invalidates the breakout.`,
        `A closed bar below ${fmt(stopLoss)} invalidates this setup.`,
        'Relative volume falling back below 1x while price stalls removes the participation premise.',
      ],
      levels: {
        entryLow: channelUpper,
        entryHigh: entry * 1.003,
        stopLoss,
        takeProfit1: entry + this.parameters.target1R * riskPerUnit,
        takeProfit2: entry + this.parameters.target2R * riskPerUnit,
      },
      summary: `Close ${fmt(bar.close)} broke the ${this.parameters.channelPeriod}-bar high ${fmt(channelUpper)} on ${fmt(relVol)}x average volume.`,
    };
  }
}
