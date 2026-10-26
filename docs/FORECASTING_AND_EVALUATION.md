# Forecasting and strategy validation

The purpose of this document is to make it hard to fool yourself.

---

## 1. Four categories that are never mixed

| Category | What it is | Status here |
|---|---|---|
| **Historical backtest** | Strategy replayed over stored candles | Implemented (walk-forward, no lookahead) |
| **Forward evaluation** | Signals this app generated live, scored afterwards | Implemented |
| **Paper trading** | Simulated order placement with fills and latency | **Not implemented** — shown as empty, not approximated |
| **Real trading** | Actual executed trades | **Not implemented** and out of scope |

The Evaluation page renders backtest and forward results in separate sections
and states explicitly that paper and real results do not exist.

---

## 2. The no-lookahead contract

At each step `t` of a backtest the strategy sees **only** `bars[0..t]`.
Indicators are recomputed from that slice, so no indicator can be influenced by
a bar that had not yet closed. Outcomes are then measured on `bars[t+1..]`,
which the strategy never saw.

Two structural protections in the indicator library:

* **Swing pivots** require `lookback` bars on *both* sides, so none can form in
  the most recent `lookback` bars.
* **Donchian channels** exclude the current bar.

**Observations are never shuffled.** Shuffling a time series would leak future
information into training, so chronological order is treated as part of the
experiment.

### How this is tested, not just asserted

`tests/evaluation.test.ts` runs a backtest, then **multiplies the last 50 bars
by 3** and runs it again. Every signal generated before that point must be
identical. If the strategy could see the future, the trade list would change.
It does not.

---

## 3. Outcome rules

A long setup is resolved by whichever comes first:

1. **Stop hit** — a bar's low reaches the stop.
2. **Target hit** — a bar's high reaches take-profit 1.
3. **Horizon elapsed** — exit at the close of the last bar in the strategy's
   fixed horizon (`timeout_gain` / `timeout_loss`).

Horizons: trend-following 20 bars, breakout 20 bars, mean-reversion 12 bars.

**Three rules that stop results from being flattered:**

* **A brief favourable excursion is not a win.** Maximum favourable and adverse
  excursion are recorded as *diagnostics only*. The outcome comes from the rules
  above.
* **Intrabar ambiguity resolves pessimistically.** When a single bar's range
  contains both the stop and the target, OHLC data cannot tell which came first.
  The evaluator **assumes the stop**, consistently.
* **Costs are charged twice** — on entry and on exit — using the per-asset-class
  assumptions, which are stored on each evaluation row so changing a default
  later cannot rewrite history.

An evaluation stays `pending` until the horizon completes; pending trades are
excluded from every statistic.

---

## 4. Independence of observations

Signals that fire while an earlier signal on the same asset and strategy is
still open are **not independent** — they overlap the same price move.

Such trades are flagged `overlaps_prior` and **excluded from headline
statistics** by default. The Evaluation page shows how many were excluded, and
the metrics module can report the inclusive figure for comparison. Counting them
as independent would inflate the apparent sample size and understate drawdown
correlation.

---

## 5. Metrics

Win rate, average gain, average loss, expectancy (% and R), profit factor, max
drawdown (sum-of-returns equity curve), total return, best/worst trade, and
observation counts.

Deliberate choices:

* **Profit factor is `null`, not `Infinity`,** when there are no losses — an
  undefined ratio is reported as undefined.
* **A sample under 30 trades carries an explicit warning** rendered next to the
  numbers: at least 30 are needed before the statistics mean anything, and even
  then they are descriptive, not predictive.
* **A buy-and-hold benchmark over the same window** accompanies every backtest,
  and the page states plainly whether the strategy beat it.

---

## 6. Measured results

Run on real Binance daily candles (`npm run backtest -- BTCUSDT 1d`),
299 closed bars, 2025-12-27 → 2026-10-21, 178 bars tested after warm-up:

| Strategy | Signals | Trades | Win rate | Expectancy/trade | Profit factor | Sum of returns | Buy & hold |
|---|---|---|---|---|---|---|---|
| `trend_follow_ema` | 2 | 2 | 0.0% | **−5.073%** | 0.00 | **−10.15%** | +6.91% |
| `breakout_donchian` | 2 | 2 | 50.0% | +0.947% | 1.41 | +1.89% | +6.91% |
| `mean_revert_bb` | 0 | 0 | — | — | — | — | +6.91% |

**Interpretation: this is not evidence of anything.** Two trades per strategy is
far below any threshold for inference. Both strategies that traded
**underperformed simply holding the asset**. The mean-reversion strategy
produced no signals at all, because BTC was not in its eligible regime.

These numbers are reported exactly as produced. They are not cherry-picked to a
favourable window, and no parameter was adjusted after seeing them.

---

## 7. Forecasting

Treated as **experimental**. Forecasts are displayed on their own page and
**never influence a signal**.

Three baselines, each evaluated with an expanding chronological window where a
prediction for bar `t` uses only closes strictly before `t`:

| Model | Definition |
|---|---|
| **Naive** | Next close = last close. The benchmark. |
| **Drift** | Extends the average per-bar change by one bar. |
| **SMA slope** | Extends the slope of a 10-period SMA by one bar. |

### Measured results (BTCUSDT 1d, 60 out-of-sample observations)

| Model | MAE | RMSE | Directional accuracy | RMSE vs naive |
|---|---|---|---|---|
| Naive | — | 1442.51 | 53.3% | 1.000 |
| Drift | — | 1447.80 | 46.7% | **1.004** |
| SMA slope | — | 1587.96 | 41.7% | **1.101** |

**Neither model beats the naive baseline.** Directional accuracy near 50% is
what a coin flip produces. This is the expected result for liquid markets at
daily horizons, and it is displayed in the app with that verdict attached
("Did NOT beat the naive baseline... It must not be used to influence signals").

The ±1σ band shown next to a point forecast is the standard deviation of the
last 20 closes. It is **not** a calibrated prediction interval — coverage has
not been validated, and the UI says so.

**Rule going forward:** any more complex model must beat the naive baseline on
out-of-sample data *before* it is allowed to influence anything.

---

## 8. Why parameters are not optimised

Tuning a dozen parameters over a few hundred bars reliably finds a configuration
that looks excellent in-sample and fails out-of-sample. So:

* Parameters are round numbers chosen a priori.
* No parameter has been adjusted in response to the results above.
* No strategy is selected for having the best in-sample result.
* Any parameter change requires a **version bump**, because the version is part
  of a signal's identity — old history stays attributable to the old rules.

---

## 9. Honest limitations

* **Sample sizes are tiny.** Every figure above is descriptive.
* **The simulator is simplified:** entry at the signal bar's close, a flat
  basis-point cost model, no partial fills, no funding or borrowing costs, no
  market-impact model.
* **Stored history is short.** Deeper backtests need the worker to accumulate
  candles over time, or a provider with longer free history.
* **Survivorship and selection bias** are not addressed: the watchlist is chosen
  by hand, today, with hindsight about which assets exist and matter.
* **Regime labels are not validated** against any external definition; they
  apply stated thresholds consistently, which is all they claim.
* **One market, one timeframe** so far. A strategy that works on BTC daily bars
  says nothing about IDX equities or 15-minute bars.
