# Implementation roadmap

## Status legend

**Built** = implemented and exercised · **Partial** = implemented with a stated
gap · **Unverified** = implemented, never run against the live service ·
**Planned** = not written

---

## Phase 1–2 · Foundation — **Built**

Next.js 16 App Router (Turbopack), React 19, TypeScript (strict + `noUncheckedIndexedAccess`),
Tailwind, portable SQL schema on SQLite/PostgreSQL, Zod-validated environment
config, responsive dark dashboard shell, error/empty/loading/stale states.

## Phase 3 · Market data — **Built / Partial**

| Item | Status |
|---|---|
| Binance adapter | **Built**, verified live |
| Coinbase adapter | **Built**, verified live |
| Nasdaq adapter | **Built**, verified live (intraday volume genuinely unavailable) |
| Alpha Vantage adapter | **Built**, verified with the demo key |
| Twelve Data adapter | **Unverified** (needs a key; IDX access unconfirmed) |
| Yahoo adapter | **Unverified**, opt-in, IP-rate-limited here |
| Normalisation, freshness, sessions/DST | **Built** |
| Retry/backoff, rate-limit handling, SSRF guard | **Built** |
| **IDX data source** | **Partial** — modelled fully, no verified free provider |

## Phase 4 · Watchlist, assets, charts — **Built**

Watchlist CRUD with provider-backed symbol search, scanner with filters and
sorting, asset detail with candlestick + volume chart, per-style timeframe
switching, provenance on every view.

## Phase 5 · Indicators and strategies — **Built**

SMA, EMA, RSI, MACD, ATR, Bollinger, volume analysis, Donchian, swing levels —
24 unit tests. Three versioned strategies with regime gating.

## Phase 6 · Signal feed and history — **Built**

Deterministic engine, risk sizing, stable `signal_key`, signal feed and detail
pages, history page with forward outcomes.

## Phase 7 · News and AI — **Built / Unverified**

| Item | Status |
|---|---|
| RSS/Atom ingestion, dedupe, classification, asset matching | **Built**, verified live |
| Injection sanitisation and fencing | **Built**, 13 tests |
| Prompt construction and schema validation | **Built**, tested |
| Anthropic / OpenAI / OpenRouter / Ollama adapters | **Unverified** — no key configured |

## Phase 8 · Notifications — **Built / Unverified**

In-app alerts with state-transition dedupe and a delivery log: **Built**.
Telegram: **Unverified** (implemented with a self-test).

## Phase 9 · Evaluation and backtesting — **Built**

Forward evaluation with pessimistic tie-breaks and overlap flagging;
walk-forward backtest with a tested no-lookahead contract; metrics with explicit
small-sample warnings; forecast baselines with out-of-sample comparison.

## Phase 11 · Positions and the real-trading loop — **Built**

| Item | Status |
|---|---|
| `positions` table, repository, API | **Built** |
| Live per-position plan (P&L, level distances, hold/sell) | **Built** |
| Engine prefers real holdings over the signal proxy | **Built** |
| Stop-breached / exit-signal / target-reached alerts | **Built**, deduped per position *and* bar |
| Portfolio page, record-buy and record-sale forms | **Built** |
| "I bought this signal" prefill from signal detail | **Built** |
| Indodax provider (IDR, all 7 timeframes) | **Built**, verified live |

## Phase 10 · Security, tests, docs — **Built**

Auth, validation, SSRF guards, injection defence, 156 tests, clean typecheck,
clean lint, successful production build, 11 documents.

---

## Next, in priority order

### 1. Resolve IDX data (highest value)

Options, best first: a Twelve Data key and `providers:verify` to confirm
free-plan IDX access; an IDX-licensed local broker API; a legitimate paid feed;
or a scheduled scrape of IDX's published daily summary files, within their
terms. Until one lands, the honest NO DATA stays.

### 2. Accumulate history, then re-evaluate

Current results rest on 2 trades per strategy. Run the worker continuously for
weeks, then revisit the Evaluation page. Expect the conclusion to remain
"inconclusive" for a long time, and resist tuning parameters to improve it.

### 3. Verify the unverified

Configure one AI provider (Ollama costs nothing and keeps data local) and a
Telegram bot, run `npm run providers:verify`, and promote their status in the
docs and the coverage matrix.

### 4. Test gaps

Component tests for the data-provenance components; a Playwright flow for
login → dashboard → asset → signal; a PostgreSQL integration run in CI.

### 5. Smaller improvements

Higher-timeframe trend confirmation for lower-timeframe entries; configurable
strategy parameters in the UI (with forced version bumps); a data-retention job;
CSV export of signals and evaluations; a `provider_failure` alert path;
per-asset cost overrides.

### Next for the position workflow

* Partial sells (currently a position closes in full).
* Multiple lots per asset with weighted average entry.
* Realised-performance statistics on the Evaluation page, as a **fourth**
  category kept separate from backtest, forward and paper results.
* Optional FX rate so cross-currency totals become possible — today they are
  deliberately not summed.

### Deliberately deferred

Order execution (permanently out of scope), automated paper trading, ML price
models (baselines do not beat naive yet), multi-user support, WebSocket
streaming.
