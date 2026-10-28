import { at } from '@/lib/indicators';
import type { AssetClass, MarketRegime, Timeframe } from '@/lib/market/types';
import type { RuleOutcome, Strategy, StrategyContext, StrategyOutput } from './types';
import { describeExits, describeFailures, fmt, strengthFromRules } from './types';

/**
 * Strategy: Trend momentum (trend_momentum v1.0.0)
 *
 * Built for Indodax's costs (~0.7% per round trip). Short setups with tight
 * stops lose most of their reward to costs, so this one trades rarely, on the
 * 4h chart, with a WIDE stop: the risk per trade is several percent, which
 * makes the fixed cost small relative to it. Rules were chosen before being
 * validated and are not tuned to any backtest result.
 *
 * ENTRY (all mandatory on the latest CLOSED bar):
 *   M1  EMA50 > EMA200                               - an established uptrend
 *   M2  close > EMA20 > EMA50                        - momentum aligned with it
 *   M3  close above the highest close of the previous 10 bars - fresh strength
 *   M4  RSI between 55 and 80                        - momentum, not exhaustion
 *   M5  ATR between 1% and 8% of price               - room for a target beyond costs
 *   M6  relative volume >= 1.0 (optional; skipped without volume data)
 * The 4h higher-timeframe filter (daily trend up) is applied by the plan engine.
 *
 * EXIT while open: close below EMA50 (trend broken), or target 1 reached.
 * STOP: entry - 2.5 x ATR.  TARGETS: 2R and 4R.  HORIZON: 30 bars (5 days on 4h).
 *
 * A CANDIDATE strategy: whether it works on Indodax is what validation decides.
 */
export class TrendMomentumStrategy implements Strategy {
  readonly id = 'trend_momentum';
  readonly version = '1.0.0';
  readonly name = 'Trend momentum (new 10-bar closing high in an established uptrend)';
  readonly description =
    'Buys a fresh 10-bar closing high while EMA20 > EMA50 > EMA200, with a wide 2.5 ATR stop so costs stay small relative to the risk.';
  readonly assetClasses: AssetClass[] = ['crypto'];
  readonly timeframes: Timeframe[] = ['4h'];
  readonly eligibleRegimes: MarketRegime[] = ['uptrend', 'high_volatility'];
  readonly warmupBars = 220;
  readonly evaluationHorizonBars = 30;
  readonly parameters = {
    breakoutLookback: 10,
    rsiFloor: 55,
    rsiCeiling: 80,
    minAtrPct: 0.01,
    maxAtrPct: 0.08,
    atrMultiplier: 2.5,
    volumeFactor: 1.0,
    target1R: 2,
    target2R: 4,
  };

  /** Highest close of the `n` bars before index i (not including i). */
  private priorHighClose(ctx: StrategyContext, i: number): number | null {
    const n = this.parameters.breakoutLookback;
    if (i - n < 0) return null;
    return Math.max(...ctx.bars.slice(i - n, i).map((b) => b.close));
  }

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

    const ema20 = at(ind.emaFast, i);
    const ema50 = at(ind.emaSlow, i);
    const ema200 = at(ind.emaLong, i);
    const rsiNow = at(ind.rsi, i);
    const atrNow = at(ind.atr, i);
    const relVol = at(ind.volume.relativeVolume, i);
    const atrPct = atrNow !== null && bar.close > 0 ? atrNow / bar.close : null;

    if (ctx.hasOpenPosition) {
      const exitRules: RuleOutcome[] = [
        {
          id: 'X1',
          description: 'Close fell below EMA50 (the trend being ridden is broken)',
          passed: ema50 !== null && bar.close < ema50,
          detail: `close ${fmt(bar.close)} vs EMA50 ${fmt(ema50)}`,
        },
        {
          id: 'X2',
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
        summary: anyExit ? describeExits(exitRules) : 'The uptrend is intact; no exit condition met.',
      };
    }

    if (!this.eligibleRegimes.includes(ctx.regime)) {
      return {
        action: 'WAIT',
        strength: 'insufficient',
        rules: [
          {
            id: 'R0',
            description: 'Market regime permits a momentum entry',
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

    const priorHigh = this.priorHighClose(ctx, i);
    const rules: RuleOutcome[] = [
      {
        id: 'M1',
        description: 'EMA50 above EMA200 (established uptrend)',
        passed: ema50 !== null && ema200 !== null && ema50 > ema200,
        detail: `EMA50 ${fmt(ema50)} vs EMA200 ${fmt(ema200)}`,
      },
      {
        id: 'M2',
        description: 'Close above EMA20, and EMA20 above EMA50',
        passed: ema20 !== null && ema50 !== null && bar.close > ema20 && ema20 > ema50,
        detail: `close ${fmt(bar.close)} · EMA20 ${fmt(ema20)} · EMA50 ${fmt(ema50)}`,
      },
      {
        id: 'M3',
        description: `Close above the highest close of the previous ${this.parameters.breakoutLookback} bars`,
        passed: priorHigh !== null && bar.close > priorHigh,
        detail: `close ${fmt(bar.close)} vs prior high close ${fmt(priorHigh)}`,
      },
      {
        id: 'M4',
        description: `RSI between ${this.parameters.rsiFloor} and ${this.parameters.rsiCeiling}`,
        passed: rsiNow !== null && rsiNow > this.parameters.rsiFloor && rsiNow < this.parameters.rsiCeiling,
        detail: `RSI ${fmt(rsiNow)}`,
      },
      {
        id: 'M5',
        description: 'Volatility leaves room for a target beyond costs',
        passed: atrPct !== null && atrPct >= this.parameters.minAtrPct && atrPct <= this.parameters.maxAtrPct,
        detail: `ATR is ${fmt((atrPct ?? 0) * 100)}% of price (band ${(this.parameters.minAtrPct * 100).toFixed(1)}%-${(this.parameters.maxAtrPct * 100).toFixed(1)}%)`,
      },
      {
        id: 'M6',
        description: `Relative volume at least ${this.parameters.volumeFactor}x its 20-bar average`,
        passed: relVol !== null && relVol >= this.parameters.volumeFactor,
        detail: ind.volume.unavailable
          ? 'provider supplies no volume for this series - rule skipped, not assumed to pass'
          : `relative volume ${fmt(relVol)}`,
        skipped: ind.volume.unavailable || relVol === null,
      },
    ];

    const mandatory = ['M1', 'M2', 'M3', 'M4', 'M5'];
    if (!rules.filter((r) => mandatory.includes(r.id)).every((r) => r.passed) || atrNow === null) {
      return {
        action: 'WAIT',
        strength: 'insufficient',
        rules,
        risks: [],
        invalidation: [],
        levels: null,
        summary: `Entry conditions not met — ${describeFailures(rules.filter((r) => mandatory.includes(r.id) && !r.passed))}.`,
      };
    }

    const entry = bar.close;
    const stopLoss = entry - this.parameters.atrMultiplier * atrNow;
    const r = entry - stopLoss;
    return {
      action: 'BUY',
      strength: strengthFromRules(rules),
      rules,
      risks: [
        'Momentum entries buy strength; a reversal right after a new high is the common failure.',
        `The stop is wide (${fmt((r / entry) * 100)}% below entry) so normal swings do not end the trade - the loss if it is hit is correspondingly larger per unit, which the position size accounts for.`,
        'Trend-following results depend heavily on the market trending; in a sideways market most entries time out or stop out.',
      ],
      invalidation: [
        `A closed bar below ${fmt(stopLoss)} invalidates this setup.`,
        `A close below EMA50 (${fmt(ema50)}) means the trend being ridden has broken.`,
      ],
      levels: {
        entryLow: priorHigh ?? entry,
        entryHigh: entry * 1.003,
        stopLoss,
        takeProfit1: entry + this.parameters.target1R * r,
        takeProfit2: entry + this.parameters.target2R * r,
      },
      summary: `Fresh ${this.parameters.breakoutLookback}-bar closing high ${fmt(bar.close)} with EMA20 > EMA50 > EMA200 and RSI ${fmt(rsiNow)}.`,
    };
  }
}
