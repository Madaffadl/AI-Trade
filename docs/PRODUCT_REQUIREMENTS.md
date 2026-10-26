# Product requirements

## Purpose

A private, single-user platform that monitors crypto and stock markets, surfaces
potential trade setups with explicit reasoning and risk, and keeps an honest
record of how those setups actually worked out.

**Not** an execution system, not a signal service, not investment advice.

## The questions it answers

| Question | Where |
|---|---|
| What is worth monitoring right now? | Scanner, Overview |
| Which assets have a BUY/SELL/HOLD/WAIT setup? | Signals, Scanner |
| Why did the system produce this signal? | Signal detail — every rule with PASS/FAIL/SKIP and the observed values |
| What news might affect this asset? | News, Asset detail |
| Entry, stop-loss, take-profit? | Signal detail, Asset detail |
| Risk/reward? | Signal detail — gross and net of assumed costs |
| What would invalidate the thesis? | Signal detail, AI commentary |
| How has this performed? | Evaluation (forward + backtest, kept separate), History |
| Which style/timeframe has the best setups? | Scanner filters, Evaluation per strategy |

---

## Scope

### In scope and **built**

* Crypto (Binance, Coinbase) and US stocks (Nasdaq, Alpha Vantage) with real data
* Normalised internal market model; provider-agnostic business logic
* Data-quality classification that gates signal generation
* Watchlist, scanner, asset detail with candlestick charts
* 9 indicators; 3 documented, versioned strategies
* Deterministic signal engine with risk sizing and stable signal identity
* News ingestion from official and reputable RSS/Atom sources
* Optional AI commentary, schema-validated, cached and capped
* In-app alerts; optional Telegram
* Forward signal evaluation + walk-forward backtesting
* Forecast baselines with out-of-sample comparison
* Single-user authentication; cron bearer tokens
* **Position tracking**: record real fills at Indodax/Pluang/Stockbit, live
  plan per holding (P&L, stop/target distances, hold-or-sell), realised P&L on
  close, and position-driven alerts
* **Indodax integration** so IDR crypto is priced on the venue actually used
* Eleven application pages, dark financial UI, responsive

### In scope but **partial**

| Item | State |
|---|---|
| **IDX stocks** | Modelled end-to-end (exchange, sessions, symbol translation, IDR). **No verified free data source** — displays NO DATA with the reason. Opt-in Yahoo/Twelve Data paths exist, both unverified. |
| **Scalping (1m/5m)** | Supported for crypto. Not realistic for stocks on free providers; the app refuses rather than pretends. |
| **AI providers** | Four adapters implemented; none exercised against a live endpoint here (no key). |
| **Telegram** | Implemented with a self-test; unverified here. |
| **Exchange holidays** | Supported via configuration; no calendar shipped, because a stale one is worse than none. |

### Explicitly **out of scope** for this release

Order execution; brokerage credentials; automated paper trading; ML price
models; multi-user accounts; short-selling signals; options/futures.

(Manual **position tracking** was originally deferred but is now built — it is
the centre of the user's workflow. What remains out of scope is anything that
*places* or *simulates* orders.)

---

## Non-functional requirements

| Requirement | How it is met |
|---|---|
| **Near-zero cost** | Default stack uses only key-less providers and a local SQLite file. No paid service is mandatory. |
| **Quota discipline** | Per-timeframe cache TTLs; refresh limited to watchlist assets at one timeframe each; page renders never fetch; AI calls cached and capped. |
| **Analytical transparency** | Every signal stores its rules, values, risks, invalidation conditions and indicator snapshot. |
| **Fact vs. inference** | Deterministic values and AI commentary are visually and structurally separated; AI cannot emit a number. |
| **Resilience** | Provider failure degrades to cached data relabelled `delayed`, never to invented data. |
| **Security** | Server-only secrets, auth gate, Zod validation, SSRF guards, injection defence. |
| **Honesty** | Unverified integrations are labelled unverified in the UI and the docs; poor results are published. |

---

## Acceptance criteria — verified status

Run on 2026-10-22/23 on the development machine.

### Market data

| Criterion | Status |
|---|---|
| At least one real crypto source works | **PASS** — Binance and Coinbase both returned live candles |
| At least one real stock source works | **PASS** — Nasdaq returned AAPL daily OHLCV |
| Unsupported markets clearly disclosed | **PASS** — IDX shows NO DATA with per-provider reasons |
| Prices and candles validated | **PASS** — tested |
| Data vs retrieval timestamps distinct | **PASS** — separate columns, both displayed |
| Missing/stale data handled | **PASS** — gaps reported not filled; staleness gates signals |
| Provider failure does not crash the app | **PASS** — falls back to cached data, relabelled |

### Signals

| Criterion | Status |
|---|---|
| Indicator unit tests | **PASS** — 24 tests, RSI validated against Wilder's published values |
| Rules deterministic and documented | **PASS** — SIGNAL_METHODOLOGY.md |
| Identical inputs reproduce signals | **PASS** — tested per strategy |
| Insufficient data suppresses signals | **PASS** — tested |
| Entry and exit rules explicit | **PASS** |
| Risk/reward tested | **PASS** — 11 risk tests |
| Duplicate notifications prevented | **PASS** — unique `signal_key` + alert `dedupe_key`, both tested |
| Traceable timestamp + strategy version | **PASS** |

### News and AI

| Criterion | Status |
|---|---|
| Sources and timestamps retained | **PASS** — publisher, URL, published/event/fetched |
| Duplicates handled | **PASS** — 3 of 35 collapsed in a live run |
| AI responses schema-validated | **PASS** — Zod + forged-citation and forbidden-claim rejection, tested |
| Unsupported claims not presented as fact | **PASS** — AI badge, no numeric fields in the schema |
| Missing AI credentials don't break TA | **PASS** — app runs with `AI_PROVIDER=none` today |
| Missing news provider doesn't break monitoring | **PASS** — SEC feed skipped with a reason; everything else continued |

### Security

| Criterion | Status |
|---|---|
| No secrets in frontend bundles or responses | **PASS** — verified by grep over `.next/static` |
| Env files excluded from Git | **PASS** — `.gitignore` verified |
| Protected routes enforce authorization | **PASS** — proxy (`src/proxy.ts`); localhost-only when no password set |
| External input validated | **PASS** — Zod on every route |

### Engineering quality

| Criterion | Status |
|---|---|
| TypeScript passes | **PASS** — `tsc --noEmit`, strict + `noUncheckedIndexedAccess` |
| Lint passes | **PASS** — 0 errors, 0 warnings |
| Critical unit tests pass | **PASS** — 156/156 |
| Production build succeeds | **PASS** — 25 routes |
| README instructions verified | **PASS** — the documented sequence is exactly what was run |

### Not verified

* AI provider live calls (no key configured)
* Telegram delivery (no bot token)
* PostgreSQL at runtime (no instance available; portability enforced statically)
* Component/E2E automated tests (pages checked manually in a browser)
