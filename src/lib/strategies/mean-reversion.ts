import { at } from '@/lib/indicators';
import type { AssetClass, MarketRegime, Timeframe } from '@/lib/market/types';
import type { RuleOutcome, Strategy, StrategyContext, StrategyOutput } from './types';
import { fmt, strengthFromRules, describeExits, describeFailures } from './types';

/**
 * Strategy: Bollinger mean reversion (mean_revert_bb v1.0.0)
 *
 * Idea: in a range-bound market, buy a stretched move below the lower band once
 * price starts to recover, targeting the band mid-line.
 *
 * Deliberately restricted to `sideways` and `low_volatility` regimes: buying
 * dips inside a downtrend is how mean-reversion systems produce their worst
 * losses, so the regime gate - not a weighting - prevents it.
 *
 * ENTRY (all must hold on the latest CLOSED bar):
 *   M1  the previous bar closed below the lower Bollinger band  - stretched
 *   M2  the current bar closed back above the lower band        - recovery
 *   M3  RSI was below rsiOversold within the last `lookback` bars
 *   M4  RSI is now rising                                       - momentum turn
 *   M5  close is below the band mid-line                        - room to target
 *
 * EXIT:
 *   X1  close reached or exceeded the band mid-line (target)
 *   X2  close below the entry bar's low (recovery failed)
 *
 * STOP: below the lower band / recent low minus an ATR buffer.
 * TARGET: the band mid-line, with a second target at the upper band.
 *
 * CANDIDATE strategy - unproven. See the Strategy Evaluation page.
 */
/**
 * MEASURED LIMITATION — this strategy has never produced a signal.
 *
 * Diagnosed against real stored candles (2026-10-26) across BTCUSDT, DOGEUSDT,
 * NVDA, TSLA, AAPL and MSFT daily — roughly 1,140 evaluated bars in total.
 * Signals generated: zero, on every one.
 *
 * The cause is NOT a broken rule. It is a tension between two of its own
 * requirements:
 *
 *   - The regime gate only permits entries in `sideways` or `low_volatility`.
 *     On BTCUSDT daily that was 5 of 183 bars (2.7%); 48.6% was `uptrend` and
 *     31.1% was `high_volatility`. On DOGEUSDT and TSLA it was 0 bars.
 *   - Rule M1 requires the previous bar to CLOSE BELOW the lower Bollinger
 *     band — a volatility event.
 *
 * In a low-volatility regime the bands are narrow but price also stops making
 * conviction moves outside them, so the two conditions are close to mutually
 * exclusive. Over the 5 eligible BTCUSDT bars, M1 passed 0 times.
 *
 * This is left UNCHANGED on purpose. Widening the regime gate (for example to
 * admit `high_volatility`, which is a volatility state rather than a trend
 * direction) would make it fire — but loosening a rule until signals appear is
 * precisely the "tool that always finds a reason to buy" this project exists
 * not to be. Changing it is a product decision about real money, not a tuning
 * detail, so it is reported rather than quietly adjusted.
 */
export class MeanReversionStrategy implements Strategy {
  readonly id = 'mean_revert_bb';
  readonly version = '1.0.0';
  readonly name = 'Bollinger mean reversion';
  readonly description =
    'Buys a recovery back inside the lower Bollinger band in a range-bound market, targeting the band mid-line.';
  readonly assetClasses: AssetClass[] = ['crypto', 'stock'];
  readonly timeframes: Timeframe[] = ['15m', '1h', '4h', '1d'];
  readonly eligibleRegimes: MarketRegime[] = ['sideways', 'low_volatility'];
  readonly warmupBars = 120;
  readonly evaluationHorizonBars = 12;
  readonly parameters = {
    bbPeriod: 20,
    bbStdDev: 2,
    rsiOversold: 35,
    lookback: 5,
    atrBuffer: 0.5,
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

    const lower = at(ind.bollinger.lower, i);
    const lowerPrev = at(ind.bollinger.lower, i - 1);
    const middle = at(ind.bollinger.middle, i);
    const upper = at(ind.bollinger.upper, i);
    const rsiNow = at(ind.rsi, i);
    const rsiPrev = at(ind.rsi, i - 1);
    const atrNow = at(ind.atr, i);

    if (ctx.hasOpenPosition) {
      const exitRules: RuleOutcome[] = [
        {
          id: 'X1',
          description: 'Price reached the band mid-line target',
          passed: middle !== null && bar.high >= middle,
          detail: `high ${fmt(bar.high)} vs mid-line ${fmt(middle)}`,
        },
        {
          id: 'X2',
          description: 'Close below the recorded stop (recovery failed)',
          passed: ctx.openStopLoss !== null && bar.close < ctx.openStopLoss,
          detail:
            ctx.openStopLoss === null ? 'no recorded stop' : `close ${fmt(bar.close)} vs stop ${fmt(ctx.openStopLoss)}`,
        },
      ];
      const anyExit = exitRules.some((r) => r.passed);
      return {
        action: anyExit ? 'SELL' : 'HOLD',
        strength: 'moderate',
        rules: exitRules,
        risks: anyExit ? ['SELL here means exit or reduce an existing long, not open a short.'] : [],
        invalidation: [
          'A mean-reversion thesis is invalidated if the market transitions into a sustained trend.',
        ],
        levels: null,
        summary: anyExit
          ? describeExits(exitRules)
          : 'Price has not yet reached the mid-line target and the stop is intact.',
      };
    }

    if (!this.eligibleRegimes.includes(ctx.regime)) {
      return {
        action: 'WAIT',
        strength: 'insufficient',
        rules: [
          {
            id: 'R0',
            description: 'Market regime permits a mean-reversion entry',
            passed: false,
            detail: `regime is "${ctx.regime}"; this strategy only enters in ${this.eligibleRegimes.join(' or ')} to avoid buying dips inside a trend`,
          },
        ],
        risks: [],
        invalidation: [],
        levels: null,
        summary: `Regime "${ctx.regime}" is outside this strategy's eligible regimes.`,
      };
    }

    let wasOversold = false;
    let minRsi: number | null = null;
    for (let j = Math.max(0, i - this.parameters.lookback); j <= i; j++) {
      const r = at(ind.rsi, j);
      if (r === null) continue;
      minRsi = minRsi === null ? r : Math.min(minRsi, r);
      if (r < this.parameters.rsiOversold) wasOversold = true;
    }

    const rules: RuleOutcome[] = [
      {
        id: 'M1',
        description: 'Previous bar closed below the lower Bollinger band',
        passed: lowerPrev !== null && prev.close < lowerPrev,
        detail: `previous close ${fmt(prev.close)} vs lower band ${fmt(lowerPrev)}`,
      },
      {
        id: 'M2',
        description: 'Current bar closed back above the lower band',
        passed: lower !== null && bar.close > lower,
        detail: `close ${fmt(bar.close)} vs lower band ${fmt(lower)}`,
      },
      {
        id: 'M3',
        description: `RSI dipped below ${this.parameters.rsiOversold} within ${this.parameters.lookback} bars`,
        passed: wasOversold,
        detail: `lowest RSI in the window ${fmt(minRsi)}`,
      },
      {
        id: 'M4',
        description: 'RSI is rising',
        passed: rsiNow !== null && rsiPrev !== null && rsiNow > rsiPrev,
        detail: `RSI ${fmt(rsiPrev)} -> ${fmt(rsiNow)}`,
      },
      {
        id: 'M5',
        description: 'Close still below the band mid-line (room to the target)',
        passed: middle !== null && bar.close < middle,
        detail: `close ${fmt(bar.close)} vs mid-line ${fmt(middle)}`,
      },
    ];

    const allPass = rules.every((r) => r.passed);
    if (!allPass || atrNow === null || middle === null || lower === null) {
      return {
        action: 'WAIT',
        strength: 'insufficient',
        rules,
        risks: [],
        invalidation: [],
        levels: null,
        summary: `Mean-reversion conditions not met — ${describeFailures(rules)}.`,
      };
    }

    const entry = bar.close;
    const recentLow = Math.min(bar.low, prev.low);
    const stopLoss = Math.min(recentLow, lower) - this.parameters.atrBuffer * atrNow;
    const riskPerUnit = entry - stopLoss;

    if (riskPerUnit <= 0 || middle <= entry) {
      return {
        action: 'WAIT',
        strength: 'insufficient',
        rules,
        risks: [],
        invalidation: [],
        levels: null,
        summary: 'Target or stop geometry is invalid for this bar (target not above entry, or stop not below it).',
      };
    }

    const rr = (middle - entry) / riskPerUnit;

    return {
      action: 'BUY',
      strength: strengthFromRules(rules),
      rules,
      risks: [
        'Mean reversion assumes the range holds. If the market breaks into a downtrend, the "cheap" price keeps getting cheaper.',
        `Reward to the mid-line is only ${fmt(rr)}R, which is small relative to the risk of a range break.`,
        'Oversold conditions can persist far longer than a stop allows.',
      ],
      invalidation: [
        `A closed bar below ${fmt(stopLoss)} invalidates this setup.`,
        'A regime change away from sideways/low-volatility invalidates the mean-reversion premise.',
        `Failure to reach the mid-line ${fmt(middle)} within ${this.evaluationHorizonBars} bars ends the thesis.`,
      ],
      levels: {
        entryLow: lower,
        entryHigh: entry * 1.002,
        stopLoss,
        takeProfit1: middle,
        takeProfit2: upper,
      },
      summary: `Price recovered back above the lower band (${fmt(lower)}) after an oversold dip (RSI low ${fmt(minRsi)}); mid-line target ${fmt(middle)}.`,
    };
  }
}
