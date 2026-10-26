# Signal methodology

How this app decides what to show, stated precisely enough to reproduce or
refute. Nothing here is evidence that any strategy makes money; see
[FORECASTING_AND_EVALUATION.md](FORECASTING_AND_EVALUATION.md) for measured
results, including the bad ones.

---

## 1. The pipeline

```
candles → normalise → freshness gate → indicators → regime → strategy rules
        → risk sizing → deterministic signal identity → storage → alert
```

AI is **not** in this pipeline. It is added afterwards as commentary and cannot
change an action, a level, or a number.

### Hard gate: data quality

A signal is generated **only** when data quality is `ok`. Everything else
(`delayed`, `stale`, `insufficient`, `invalid`, `unavailable`) suppresses
signal generation and the reason is shown.

Freshness tolerance = bar duration × multiplier:

| Timeframe | 1m | 5m | 15m | 1h | 4h | 1d | 1w |
|---|---|---|---|---|---|---|---|
| Multiplier | 3 | 3 | 3 | 3 | 2.5 | 2.5 | 2 |

When the exchange is **closed**, an old last bar is reported as `delayed`
(market closed) rather than `stale` (data problem). Both block new signals.

### Closed bars only

The in-progress candle is stored and charted, but every strategy rule runs on
closed bars. A rule can never be satisfied by a half-formed bar that later
reverses.

---

## 2. Indicators

Pure functions, aligned to input length, `null` where warm-up is incomplete.
A `null` is "not computable" and is never treated as a neutral value.

| Indicator | Definition used |
|---|---|
| SMA(n) | Arithmetic mean of the trailing n closes |
| EMA(n) | Seeded with SMA(n), then k = 2/(n+1) |
| RSI(14) | **Wilder's smoothing.** Validated against the published Wilder worked example (70.53 / 66.32 / 66.55) |
| MACD(12,26,9) | EMA12 − EMA26; signal = EMA9 of that line |
| ATR(14) | Wilder's smoothing of True Range; TR uses the previous close, so gaps count |
| Bollinger(20,2) | SMA20 ± 2 × **population** standard deviation |
| Donchian(n) | Highest high / lowest low of the prior n bars, **excluding the current bar** |
| Swing levels | Pivots confirmed by `lookback` bars on **both** sides |
| Relative volume | volume ÷ SMA20(volume); `null` when the provider supplies no volume |

Two anti-lookahead details worth naming:

* **Swing pivots** cannot form in the most recent `lookback` bars, because
  confirmation requires bars that have not happened yet. This avoids the common
  bug of "finding" a support level using future data.
* **Donchian** excludes the current bar, so a breakout is measured against a
  channel the current bar did not help create.

---

## 3. Market regime

Deterministic classification from EMA separation, slope agreement and ATR%.
Regime **gates strategy eligibility**; it never forces a BUY or SELL.

Defaults (`DEFAULT_REGIME_CONFIG`):

| Parameter | Value | Meaning |
|---|---|---|
| fast / slow | EMA20 / EMA50 | Trend direction |
| trendSeparation | 0.5% | Below this the market is `sideways`, not trending |
| highVolAtrPct | 3% | ATR ≥ 3% of price → `high_volatility` |
| lowVolAtrPct | 0.5% | ATR ≤ 0.5% of price → `low_volatility` |
| warm-up | 55 bars | Below this → `uncertain` |

Order of evaluation: volatility extremes are reported **before** trend labels,
because they matter more for sizing and eligibility. A trend label additionally
requires the SMA50 slope over the last 10 bars to agree with the EMA
separation; if they disagree the regime is `uncertain`, not a trend.

---

## 4. Strategies

Three candidate strategies. All are **unproven**.

### 4.1 `trend_follow_ema` v1.0.0 — trend-following pullback

* **Eligible regimes:** uptrend, low_volatility
* **Timeframes:** 15m, 1h, 4h, 1d · **Asset classes:** crypto, stock
* **Warm-up:** 120 bars · **Evaluation horizon:** 20 bars

**Entry — all mandatory rules must pass on the latest closed bar:**

| Rule | Condition |
|---|---|
| T1 | EMA20 > EMA50 |
| T2 | close > EMA50 |
| T3 | A bar low touched EMA20 within the last 6 bars (the pullback) |
| T4 | close > previous bar's high (the resumption trigger) |
| T5 | 50 < RSI(14) < 75 — momentum present, not exhausted |
| T6 | MACD histogram > 0 |
| T7 | Relative volume ≥ 1.0 — **confirmation only; SKIPPED (not passed) when the provider supplies no volume** |

**Stop:** `entry − 1.5 × ATR(14)`, never looser than just below the nearest
confirmed swing low.
**Targets:** 1.5R and 3R.

**Exit (when a prior BUY is still open):** close < EMA20 (X1), MACD histogram
negative two bars running (X2), or target 1 reached (X3).

### 4.2 `breakout_donchian` v1.0.0 — breakout with volume confirmation

* **Eligible regimes:** uptrend, sideways, high_volatility
* **Warm-up:** 120 bars · **Horizon:** 20 bars

| Rule | Condition |
|---|---|
| B1 | close > 20-bar Donchian high |
| B2 | close in the upper third of the breakout bar's range |
| B3 | Relative volume ≥ 1.5 — **MANDATORY** |
| B4 | close > EMA50 |
| B5 | 0.3% ≤ ATR/price ≤ 8% |

**B3 is mandatory and has teeth:** if the data source provides no volume at all
(e.g. Nasdaq intraday), this strategy emits **no signal**, with the reason
stated. It does not degrade into a weaker version of itself.

**Stop:** the *tighter* of `entry − 1.5 × ATR` and just under the breakout
level — a breakout that closes back inside the range is already wrong.
**Targets:** 2R and 4R.

### 4.3 `mean_revert_bb` v1.0.0 — Bollinger mean reversion

* **Eligible regimes:** sideways, low_volatility **only**
* **Warm-up:** 120 bars · **Horizon:** 12 bars

| Rule | Condition |
|---|---|
| M1 | Previous bar closed **below** the lower band |
| M2 | Current bar closed back **above** it (the recovery) |
| M3 | RSI dipped below 35 within the last 5 bars |
| M4 | RSI is rising |
| M5 | close still below the band mid-line (room to target) |

The regime restriction is the point: buying dips inside a downtrend is how
mean-reversion systems produce their worst losses, so it is prevented by a
**gate**, not down-weighted.

**Stop:** `min(recent low, lower band) − 0.5 × ATR`.
**Targets:** band mid-line, then the upper band.

### Why these are not "optimised"

Parameters are round numbers chosen a priori. Tuning a dozen parameters over a
few hundred bars reliably produces results that evaporate on new data, so it
was not done. Changing any parameter requires a **version bump**, because the
version is part of a signal's identity.

---

## 5. Risk and position sizing

Deterministic (`src/lib/signals/risk.ts`). Refuses rather than guesses.

```
riskPerUnit   = entry − stop
riskAmount    = accountEquity × riskPercentPerTrade / 100
positionSize  = riskAmount / riskPerUnit        (floored to lotSize if KNOWN)
costPerUnit   = entry × (feeBps + slippageBps) / 10000
potentialLoss = positionSize × (riskPerUnit + costPerUnit)
R:R gross     = (target − entry) / riskPerUnit
R:R net       = (target − entry − costPerUnit) / (riskPerUnit + costPerUnit)
```

Costs are charged **against** reward and **added to** risk — the conservative
reading.

**Default cost assumptions** (configurable, not quotes from any venue):
crypto 10 bps fees + 5 bps slippage; stocks 2 bps + 5 bps.

**It refuses to size a position when:** the stop is not below the entry, no
target is above the entry, equity or risk% is invalid, the budget cannot buy one
tradable unit, or the notional is below a known exchange minimum.

**It discloses rather than invents:** when tick size or lot size is unknown, the
UI says the size is not rounded to a tradable increment.

Defaults: `RISK_ACCOUNT_EQUITY=10000`, `RISK_PERCENT_PER_TRADE=1`,
`RISK_MAX_OPEN_RISK_PERCENT=5`. These are **configurable examples, not personal
financial advice.**

---

## 6. Labels and strength

| Label | Precise meaning |
|---|---|
| **BUY** | Every mandatory entry rule passed on the latest closed bar, with `quality = ok`. |
| **SELL** | An exit condition fired for a position opened by a prior BUY of the *same strategy*. **Exit/reduce only — never a short.** |
| **HOLD** | A position is open and no exit condition fired. |
| **WAIT** | No valid entry, wrong regime, insufficient history, or degraded data. |

"Position" means, in order of precedence:

1. **A real holding you recorded** (venue, quantity, entry price, fees). When
   one exists, exit rules are evaluated against *your* entry, stop and target.
2. Otherwise, an earlier BUY signal from this app that is still active — a
   proxy, used only when you have not recorded a real trade.

A real position is **never closed automatically**. The app cannot know whether
you executed a sale at your venue, so it raises an alert and waits for you to
record the actual fill. A breached stop on a real position overrides a fresh
strategy opinion: the plan you committed to already said to exit.

Only BUY and SELL are stored in the feed. HOLD and WAIT are states evaluated on
every run; persisting them would flood the feed with non-events.

### Setup strength

Counted over **evaluable** rules (skipped rules are excluded from both sides):

| Strength | Rule |
|---|---|
| `insufficient` | Fewer than 3 evaluable rules, or pass ratio < 0.6 |
| `weak` | Pass ratio ≥ 0.6 |
| `moderate` | Pass ratio ≥ 0.8 |
| `strong` | **All** rules passed **and** at least 5 were evaluable |

**This is a count of confirmations, not a probability.** It says how much
evidence lined up, and nothing about the chance of profit. No calibrated
probability is shown anywhere, because there is nowhere near enough
out-of-sample evidence to justify one.

---

## 7. Signal identity and duplicate suppression

```
signal_key = sha256(strategyId | version | assetId | timeframe | action | candleOpenMs)[0:32]
```

The **trigger bar** is in the key; the generation time is not. Consequences:

* Re-running the job on the same bar → same key → insert is a no-op → **no
  alert**.
* A *new* bar that still satisfies the rules is a genuinely new setup → new key
  → new signal.
* Changing a parameter requires a version bump → new key → the old signal's
  history stays attributable to the old rules.

Alerts carry their own `dedupe_key` describing the **state** (`new_signal:<id>`,
`signal_invalidated:<id>`), and delivery only happens for a newly created alert.
That is the single place that guarantees a recalculated-but-unchanged signal
cannot re-notify.

---

## 8. Invalidation

Every signal stores explicit invalidation conditions, for example:
a closed bar below the stop; a close back below EMA50; MACD histogram crossing
back below zero; a regime change away from the strategy's eligible regimes.

The refresh job acts on the first of these: when a **closed** bar prints below
the recorded stop, the signal is marked `invalidated` and an alert is raised.
Signals older than 3× their evaluation horizon are marked `expired` so the feed
does not accumulate stale "active" setups.

---

## 9. What this methodology does not claim

* That any strategy is profitable. Measured results so far are poor; see the
  Evaluation page and the forecasting document.
* That setup strength predicts anything.
* That the regime classifier identifies regimes "correctly" — it applies stated
  thresholds consistently, which is all it claims.
* That backtested behaviour will repeat. It assumes entry at the signal bar's
  close, flat basis-point costs, and no partial fills.
