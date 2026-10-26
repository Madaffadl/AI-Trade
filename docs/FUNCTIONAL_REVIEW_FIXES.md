# Functional review — fixes

Follow-up to `docs/UI_UX_REVIEW.md`. Everything below was found by **running**
the application, and every fix was verified the same way.

---

## FAIL → fixed

### 1. Symbol search was dead in both branches

**Found:** every query returned nothing.

```
q=BBCA → {"results":[],"errors":[{"provider":"binance","error":"Response too large (17794976 bytes)."}]}
q=BTC  → same   q=AAPL → same   q=TLKM → same
```

Two separate causes:

- **Crypto.** `binance.searchSymbols()` fetches `/api/v3/exchangeInfo`, an
  ~18 MB reference document, against the 8 MB default cap. The raised cap had
  been applied to the catalogue builder only, not to search.
- **Stocks.** Returned `{"results":[],"errors":[]}` — empty with *no error*,
  because every unconfigured provider was skipped with a silent `continue`.
  In the UI "no API key" was indistinguishable from "no such symbol".

**Fixed:** search is now **catalogue-first**. The local `instrument_catalog`
(9,475 rows) answers instantly, offline, and without quota; live providers are
a top-up. An unconfigured provider is reported as a `notice`, and the watchlist
UI displays those notices.

**Verified:**

| Query | Result |
|---|---|
| `BBCA` | IDX · Bank Central Asia Tbk · IDR |
| `TLKM` | IDX · Telkom Indonesia (Persero) Tbk · IDR |
| `BTC` (crypto) | 40 from catalogue + 7 from Binance — no size error |
| `ZZZZNOPE` | 0 results **with** notices explaining which providers were skipped |

### 2. A sell instruction justified only by `X1, X2`

**Found:** the Portfolio card showed a **SELL** badge with
`Exit condition met: X1, X2.` The descriptions existed on every rule and never
left the strategy. (They *were* rendered, but collapsed inside a "Show rules"
disclosure — so the only always-visible justification was two opaque codes.)

**Fixed:** `describeExits()` and `describeFailures()` in
`lib/strategies/types.ts` put the wording into the summary, and the rule list
now auto-expands when the action is `SELL`.

**Verified** — live on an asset page:

> `conditions not met — Close above the previous bar's high (resumption trigger) (T4); RSI between 50 and 75 (T5); MACD histogram positive (T6).`

### 3. Zero Indonesian stocks in the product catalogue

**Found:** `instrument_catalog` held `BINANCE 1387 · INDODAX 449 · US 6615 ·
IDX 0`. `syncIdx()` refused to run without `TWELVEDATA_API_KEY`.

**Fixed:** the Twelve Data `/stocks` **reference** endpoint needs no key —
verified live, HTTP 200, 943 listings with real company names. The key is only
required for *candles*, a separate concern. Gate removed.

Other sources were tried and rejected, not assumed: `idx.co.id` returns 403
(Incapsula) to every programmatic request; Yahoo's search endpoint resolves
single tickers but is rate-limited **per IP** and began refusing every host
after a handful of calls (confirmed with plain `curl`, so not a client bug).

**Verified:** `IDX 943`, total `9,475`. `BBCA → Bank Central Asia Tbk / IDR`.

---

## PARTIAL → fixed

- **Price thresholds had no UI.** The API existed from day one and nothing
  called it, so the feature was reachable only with `curl`. Added a form on the
  asset page (create, list, remove) with a warning that a price alert is *not*
  a signal. Verified end to end.
- **`indodax` was unverifiable.** It serves the production IDR pairs but had no
  sample symbol, so `providers:verify` reported `skip` and a live dependency
  looked untested. Now: `[PASS] indodax BTCIDR 1h: 20 bars in 118ms`.
- **Dead table.** `technical_indicator_snapshots` was declared from the first
  migration and never read or written — a table advertising an audit trail the
  app does not keep. Removed from the schema, with the reasoning recorded there.

---

## PARTIAL → diagnosed, deliberately NOT changed

**`mean_revert_bb` has never produced a signal.** Measured across BTCUSDT,
DOGEUSDT, NVDA, TSLA, AAPL and MSFT daily — ~1,140 evaluated bars, zero
signals on every one.

The cause is a tension between two of its own requirements:

- the regime gate admits only `sideways` / `low_volatility` — on BTCUSDT that
  was **5 of 183 bars (2.7%)**, against 48.6% `uptrend` and 31.1%
  `high_volatility`; on DOGEUSDT and TSLA it was **0 bars**;
- rule **M1** requires the previous bar to *close below the lower Bollinger
  band* — a volatility event.

In a low-volatility regime the bands are narrow and price stops making
conviction moves outside them, so the two are close to mutually exclusive. Over
the 5 eligible BTCUSDT bars, M1 passed **0** times.

This is left unchanged on purpose. Widening the gate would make it fire, but
loosening a rule until signals appear is exactly the "tool that always finds a
reason to buy" this project exists not to be. It is a product decision about
real money, so it is reported rather than quietly tuned.

---

## New feature — watchlist candidates

`/recommendations`, ranking instruments by **measured** tradability.

**What it ranks:** 24-hour turnover (70%) and number of individual trades
(30%), both log-scaled. Sources are keyless public endpoints verified live —
Binance `/api/v3/ticker/24hr` (3,739 symbols in one request) and Indodax
`/api/summaries` (449 IDR pairs).

**What it refuses to do:** price direction contributes **nothing** to the
score. `scoreCandidate()` has no parameter for it, so it cannot be added
without failing to compile, and a test pins that. The page leads with a
warning, above the table, that this is not a prediction.

**Bands:** `liquid` · `active` · `speculative` · `thin`. The *speculative* band
is where the small, thinly-traded names sit — the ones explicitly asked for.

Two issues found and fixed while building it:

- **Every Indodax 24h change read exactly `0.00%`.** `tickers` is keyed
  `btc_idr` but `prices_24h` is keyed `btcidr` — no underscore. The lookup
  missed every time and fell back to the current price.
- **Currency pegs topped the ranking.** `USDCUSDT` ranked 2nd and `USD1USDT`
  8th on live data: the most liquid pairs on the venue and impossible to trade
  (day ranges 0.87% and 0.03%). Pegged assets are now excluded by identity
  rather than by tuning a threshold until they happened to drop off.

**Verified:** `PEPEIDR` added to the watchlist from the page, end to end.

---

## Verification

- 253 tests pass (22 new); typecheck, lint and production build clean.
- All 14 routes return 200 in **both** languages — switched through
  `/api/settings/locale`, since the locale lives in settings, not a cookie.
- Live provider check: binance, coinbase, **indodax**, nasdaq all `PASS`.

**Not fixed, needs a key:** IDX *candles*. `BBCA` still reports
`No configured provider can supply 1d data for IDX` — the catalogue now lists
it, but price history needs a free Twelve Data key. The app says so plainly
rather than inventing data.
