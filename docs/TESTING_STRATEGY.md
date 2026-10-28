> **Historical document.** Written for the earlier multi-market version (US/IDX stocks, Binance, watchlists) before the app was scoped to Indodax on 2026-10-29. Where it disagrees with the README, the README describes the current app.

# Testing strategy

```bash
npm test          # 259 tests, ~2s  (Vitest 5)
npm run typecheck # tsc --noEmit
npm run lint      # eslint flat config
npm run build     # production build
npm run providers:verify   # real requests to every configured provider
```

---

## Philosophy

The financial logic is written as **pure functions with no I/O and no clock
access**, so the parts that must be right can be tested exhaustively without
mocks or a network. Tests concentrate on the properties that make the app
trustworthy rather than on coverage percentage.

Four properties are tested harder than anything else:

1. **Indicator correctness** against published reference values.
2. **No lookahead** in backtests.
3. **Refusal behaviour** — the app must decline to act on bad data rather than
   produce a confident-looking number.
4. **Duplicate suppression** — the same setup must never notify twice.

---

## Current state (all passing)

| Suite | Tests | Covers |
|---|---|---|
| `indicators.test.ts` | 24 | SMA, EMA, RSI, MACD, ATR, Bollinger, volume, Donchian, swing levels |
| `market-data.test.ts` | 22 | Normalisation, freshness policy, exchange sessions/DST |
| `signals.test.ts` | 25 | Risk maths, regime classification, strategy contract |
| `evaluation.test.ts` | 22 | Outcomes, metrics, backtest lookahead, forecast baselines |
| `security.test.ts` | 35 | Prompt injection, AI validation, sessions, SQL helpers, dedupe keys |
| `providers.test.ts` | 35 | SSRF guard, RSS/Atom parsing, symbol translation, coverage honesty |
| `database.test.ts` | 11 | Real schema on a real database, constraints, portability |
| `positions.test.ts` | 13 | Position accounting, fee handling, plan-level validation |
| `i18n.test.ts` | 10 | Dictionary structure, completeness, untranslated-string and argument-usage guards |
| `ui.test.ts` | 9 | Direction encoded without colour; indicator precision by magnitude |
| `ux-contract.test.ts` | 40 | Type-scale floor, focus rings, 24px targets, table semantics, nav structure, chart a11y, plus regression guards for every functional-review fix |
| `recommend.test.ts` | 13 | Candidate scoring, banding and reason codes — including that the score cannot depend on price direction |
| **Total** | **259** | |

### Notable individual tests

* **RSI against Wilder's published example** — `70.53 / 66.32 / 66.55`. Catches
  the classic bug of using simple averaging instead of Wilder's smoothing.
* **Bollinger against the textbook set** `[2,4,4,4,5,5,7,9]` → mean 5,
  population σ 2. Catches sample-vs-population σ.
* **True Range across a gap** — asserts the previous close dominates, not
  high−low.
* **Backtest lookahead** — multiplies the final 50 bars by 3 and asserts every
  earlier signal is unchanged.
* **Gaps are not filled** — asserts a two-bar hole stays a hole, and that the
  warning says so.
* **Volume `null` ≠ 0** — asserts relative volume stays `null` and the breakout
  strategy emits no signal at all.
* **Stop-before-target tie-break** — a bar containing both levels resolves as a
  stop.
* **Favourable excursion is not a win** — price reaching 109 against a 110
  target still ends `timeout_loss`.
* **AI citation forgery** — a response citing an unsupplied URL is rejected.
* **SSRF** — `169.254.169.254` (cloud metadata) and all RFC1918 ranges blocked.
* **DST correctness** — US market open verified in both January and July.
* **Signal key stability** — same setup → same key; new bar or new version →
  new key.
* **Fees charged on both sides** — a 1,000 gross profit becomes a 5,000 net loss
  when round-trip fees exceed the move.
* **FX never silently approximates** — a missing rate yields the native value
  plus a note, and the native amount is always preserved.
* **Colour is never the only cue** — a ▲/▼ glyph accompanies every signed value,
  so the red/green pair is redundant rather than load-bearing.
* **Every interpolated message uses its arguments** — probed with string,
  boolean and numeric values, so a dead parameter cannot hide.

---

## Integration testing

`database.test.ts` runs against a **real SQLite database** created from the
production `schema.sql` — not a mock. It asserts that every required table
exists, that the DDL is idempotent, that the portability rules hold in
executable SQL, and that each unique constraint actually rejects the duplicate
it is meant to prevent.

Provider adapters are tested for parsing and guard behaviour **without
network**. Live connectivity is verified separately and explicitly by
`npm run providers:verify`, which makes one real request per provider and prints
what came back. That separation is deliberate: unit tests stay fast and
deterministic, and "the integration works" is a claim backed by a command you
can run rather than by a mock.

---

## What is NOT tested, and why

Stated plainly rather than implied by silence:

| Gap | Reason |
|---|---|
| **React component rendering** | No component test harness is configured. Pages were verified manually in a browser against live data. |
| **End-to-end browser flows** | No Playwright suite. The login redirect, dashboard, asset page and chart were checked by hand. |
| **Live provider responses in CI** | Would make the suite slow, flaky and quota-consuming. Covered by `providers:verify` instead. |
| **AI provider adapters against live APIs** | No key configured. The adapters are implemented against documented request shapes and marked **unverified** in the docs and the UI. |
| **Telegram delivery** | Same — implemented with a self-test, unverified here. |
| **PostgreSQL dialect at runtime** | Portability is enforced statically by the DDL test; no Postgres instance was available in this environment. **This is the largest untested path.** |
| **Concurrency** | Single-user, single-worker. SQLite's writer lock is untested under contention. |

---

## Adding a strategy — the test bar

Any new strategy must pass the existing contract tests in `signals.test.ts`,
which are written against the `Strategy` interface rather than a specific
implementation. They assert that it is reproducible, refuses insufficient
history, never enters outside its eligible regimes, never returns BUY when a
position is open, and always produces a stop below entry and a target above it
whenever it emits levels.

Then run `npm run backtest -- <SYMBOL> <TF>` and report the result honestly,
including when it is bad.
