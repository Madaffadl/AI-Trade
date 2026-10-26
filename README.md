# AI Trade — personal trading intelligence platform

A private, single-user **decision support** app for crypto and stock markets. It
monitors markets, computes deterministic technical signals with explicit risk
and invalidation rules, ingests financial news, tracks the positions you
actually hold, and optionally adds AI commentary on top of — never in place of —
the computed facts.

**It does not place trades, hold brokerage credentials, or spend money.**
It is a research tool, not investment advice, and nothing here is evidence that
any strategy is profitable.

## The workflow it is built around

```
1. Check AI Trade          → which asset has a setup worth acting on?
2. Buy at your own venue   → Indodax / Pluang / Stockbit (you do this yourself)
3. Record the purchase     → what you bought, at what price, where
4. AI Trade tracks it      → live plan: stop, targets, P&L, "hold or sell now?"
5. Sell at your venue      → when the plan says so
6. Record the sale         → realised P&L becomes part of your own history
```

Step 3 is what makes the rest honest: every plan figure is computed from **the
price you actually paid**, not the theoretical entry of the signal that inspired
the trade. Those two numbers are almost never the same.

---

## What is actually working

Verified by `npm run providers:verify` on 2026-10-22 from the development
machine (your results depend on your network and keys):

| Capability | Status | Notes |
|---|---|---|
| Crypto OHLCV — **Indodax (IDR)** | **Working** | Official public API, no key. All 7 timeframes. **The venue you actually buy on.** |
| Crypto OHLCV — Binance | **Working** | Public API, no key. 1m–1w. USDT-quoted. |
| Crypto OHLCV — Coinbase | **Working** | Public API, no key. No 4h bars. |
| US stocks — Nasdaq | **Working** | Undocumented public endpoint. Daily has volume; **intraday has none**. |
| US stocks — Alpha Vantage | **Working** (demo key, IBM only) | Free tier ≈ 25 requests/day. Needs your key. |
| Stocks — Twelve Data | **Unverified** | Adapter implemented and wired as the **supported IDX path**; free-plan IDX candle access could not be confirmed without a key. |
| **IDX (Indonesian) stocks** | **No verified free source** | See the honest assessment below. |
| News — Federal Reserve RSS | **Working** | No key. |
| News — CoinDesk RSS | **Working** | No key. |
| News — SEC EDGAR Atom | **Working with `SEC_USER_AGENT`** | SEC returns 403 without a contact User-Agent. |
| AI analysis | **Unverified** | Adapters for Anthropic / OpenAI / OpenRouter / Ollama are implemented but have not been run against a live endpoint here (no key configured). |
| Telegram notifications | **Unverified** | Implemented with a self-test; needs your bot token. |

### The IDX problem, stated plainly

The spec asks for Indonesian (IDX/BEI) stock coverage. Here is what was found:

* `idx.co.id`'s own data endpoints return **HTTP 403** (Incapsula bot protection).
* Yahoo Finance `.JK` symbols returned **one** successful response, then
  **persistent HTTP 429** from this IP — including after the documented
  cookie/crumb warm-up. The adapter exists but is **disabled by default**
  (`ENABLE_YAHOO_PROVIDER=true` to opt in) and is marked unverified.
* Twelve Data's reference endpoint confirms IDX symbols exist in their catalogue
  (`BBCA`, exchange `IDX`, currency `IDR`), but `time_series` requires a real
  key, so free-plan IDX candle access is **unconfirmed**.

So: the seeded watchlist includes `BBCA` on `IDX`, and the app shows it as
**NO DATA** with the exact reason **and a "How to fix" line naming the concrete
next step**. It does **not** quietly serve US data or delayed data under an
Indonesian label.

**The supported path is a free Twelve Data key.** `twelvedata` already ships in
the default `STOCK_PROVIDERS` order, so the key alone routes IDX there — no code
or config edit:

```bash
# 1. free key at https://twelvedata.com/apikey
# 2. put it in .env.local as TWELVEDATA_API_KEY=...
npm run providers:verify        # prints twelvedata[IDX] PASS or FAIL, with the real response
```

If their free plan does not cover IDX, the run says so explicitly and the app
keeps showing NO DATA rather than substituting anything. Fallback, unofficial:

```bash
npm run providers:verify -- --probe yahoo   # per-IP rate limit; may work on your network
```

---

## Quick start

```bash
cp .env.example .env.local
npm install
npm run db:migrate
npm run db:seed
npm run refresh
npm run dev
```

Open <http://localhost:3000>.

Requirements: **Node 22+** (uses the built-in `node:sqlite`; developed on Node 26).
No database server, no Docker, no Redis, no Python service.

### Verify your providers before trusting anything

```bash
npm run providers:verify
```

Prints `PASS` / `SKIP` / `FAIL` per provider with the real response it just got.
Nothing in this project should be described as "working" unless this says so on
your machine.

To test a provider that is implemented but disabled — without permanently
enabling it:

```bash
npm run providers:verify -- --probe yahoo
```

**This is the fastest way to find out whether IDX data works for you.** Yahoo's
rate limiting is per IP: it failed from the development machine but may well
succeed from your network.

### Keep data flowing

```bash
npm run worker
```

A plain long-running Node process that refreshes market data, ingests news and
evaluates past signals on conservative intervals. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for why a serverless free tier cannot
reliably do this and what to use instead.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint (flat config) |
| `npm test` | Vitest — 156 tests |
| `npm run db:migrate` | Apply `src/lib/db/schema.sql` |
| `npm run db:seed` | Reference data only — exchanges, starter watchlist, strategies. **Writes no prices.** |
| `npm run refresh` | One refresh cycle: fetch → evaluate strategies → record signals → raise alerts |
| `npm run worker` | Long-running local scheduler |
| `npm run evaluate` | Score past signals against subsequent real candles |
| `npm run backtest -- BTCUSDT 1d` | Walk-forward backtest over stored candles |
| `npm run providers:verify` | Make one real request per provider and report it |

---

## How it fits together

```
providers/  → adapters (Binance, Coinbase, Nasdaq, Alpha Vantage, Twelve Data,
              Yahoo, RSS news, 4 LLM backends). Each declares its real coverage,
              delay, quota and limitations as data.
     ↓
market/     → normalisation (invalid/duplicate/out-of-order/gaps), freshness
              policy, exchange sessions, caching service, scanner.
     ↓
indicators/ → pure functions: SMA, EMA, RSI, MACD, ATR, Bollinger, volume,
              Donchian, swing levels. Null where warm-up is incomplete.
     ↓
strategies/ → 3 documented rule sets. Pure functions of (closed bars,
              indicators). Each rule records PASS/FAIL/SKIP with real values.
     ↓
signals/    → regime gate, risk maths, deterministic signal identity, storage.
     ↓
evaluation/ → forward scoring of live signals + no-lookahead walk-forward
              backtests, kept strictly separate.
     ↓
analysis/   → optional LLM commentary, schema-validated, cached, capped.
```

### Rules the code actually enforces

* **Signals need `quality = ok`.** Stale, delayed, insufficient or invalid data
  produces no signal, with the reason shown.
* **Closed bars only.** The in-progress candle is stored and charted but
  excluded from every strategy rule.
* **Missing candles stay missing.** A gap is reported, never filled with a flat
  bar.
* **Missing volume is `null`, not `0`.** The breakout strategy refuses to fire
  at all without volume rather than firing on partial evidence.
* **Candle time ≠ retrieval time.** Separate columns, separately displayed.
* **One setup = one signal.** A signal's identity is a hash of
  (strategy, version, asset, timeframe, action, trigger bar), so re-running the
  job on unchanged data creates nothing and notifies nobody.
* **AI never produces a number.** Prices, indicators, levels and risk come from
  deterministic code. An AI response citing a URL it was not given, or promising
  profit, is rejected rather than displayed.
* **News is untrusted input.** Instruction-like text is flagged and stripped,
  then fenced as data in the prompt.

### Product catalogue — the watchlist is yours to choose

The seeded watchlist is **demo data, not a recommendation.** The **Produk** page
lists every instrument the configured providers can actually serve, and you pick:

| Source | Instruments catalogued |
|---|---|
| Indodax | 449 IDR pairs |
| Binance | 1,387 spot symbols |
| Nasdaq screener | 6,615 US equities **with market cap** |
| Twelve Data (IDX) | needs `TWELVEDATA_API_KEY` |

Filter by asset class, exchange, free-text search, and — for US stocks — a
**market-cap band** (mega / large / mid / small / micro / unknown), so small and
micro caps are first-class, not hidden.

An honest caveat is shown when you filter to small/micro caps: thin liquidity
means wide spreads and volume that can mislead. The strategies here refuse to
signal when ATR falls outside its workable band or volume is unavailable, so
**some instruments will never produce a signal.** That is the design working,
not a fault. Adding something to the watchlist is never an endorsement — the app
does not pick assets for you.

### Visual design, computed rather than eyeballed

The palette was run through the dataviz skill's validator, not chosen by taste.
Two measured failures came back and both were real:

| Measured problem | Fix | Result |
|---|---|---|
| up/down `#3fb950`/`#e5534b` → **deuteranopia ΔE 4.6**, below even the floor of 6 | green moved toward teal `#13a383`, keeping the finance convention | **ΔE 8.2**, clears the ≥8 target |
| `ink-faint` `#5a6677` → **3.1:1** on raised surfaces, failing WCAG AA for the *smallest* text in the app | `#788598` | **4.84:1**, three distinct text levels (16 / 6.1 / 4.8) |

```bash
node scripts/validate_palette.js "#13a383,#e5484d,#3d8bfd,#b07d10" \
  --mode dark --surface "#0b0e13"     # → ALL CHECKS PASS
```

**Colour is never the only cue.** Every directional value carries a ▲/▼ glyph
*and* a signed number, so red/green is redundant rather than load-bearing. Pinned
by tests, so a refactor cannot quietly drop it.

Other corrections from the same pass: `tabular-nums` removed from standalone
stat values (equal-width digits make a large number look loose) and kept only in
table columns; EMA overlays widened to the 2px line spec with a real legend
(identity must never rely on matching colours by eye); one hero figure per view;
and chart axis ticks compacted — an IDR axis was rendering `1800000000.00`,
now `1.80B`.

### Built for someone who has never traded

* **A 6-step guide on the overview** walks through the whole loop, with three
  blunt warnings before you risk money. Collapsible, and remembered per browser.
* **~72 glossary tooltips.** Hover or tap any dotted word or `?` to get a plain
  explanation. Every entry follows the same rule: define the term, say what it
  is used for *here*, and state the limitation — never imply a reading predicts
  anything. Available in both languages.
* **Every product is clickable.** Any of the 8,451 catalogued instruments opens
  a full detail page with a live chart — not just the ones you track.

### Opening any instrument

Clicking a product registers the asset and opens `/assets/<id>` with live data,
**without** adding it to the watchlist. That split is deliberate and was already
in the schema: `assets` means "instruments we know about", `watchlist_assets`
means "instruments we actively refresh". Browsing must never silently commit you
to spending provider quota.

The chart carries EMA 20 / 50 / 200 overlays computed from the **same closed-bar
series the strategies use**, so what you see is what the rules saw. Warm-up gaps
are left unplotted rather than joined across the hole.

### Interface language (English / Bahasa Indonesia)

A toggle in the header switches the whole interface. The implementation is a
typed dictionary rather than an i18n library, for one specific reason: **a
missing translation is a compile error, not a blank string.** `id.ts` is typed
as `Messages` (derived from `en.ts`), so adding an English key and forgetting
the Indonesian one fails `npm run typecheck`. A runtime framework would instead
fall back to printing the key.

Four guards beyond the type system, all tested:

* both dictionaries keep an identical key structure;
* no key is empty in either language;
* no long English string was left verbatim in the Indonesian file (short shared
  terms like `Crypto` and venue names are allow-listed);
* **every interpolated message actually uses all of its arguments** — probed
  with string, boolean and numeric values, because an argument may be
  interpolated into the text *or* used as a condition.

`BUY` / `SELL` / `HOLD` / `WAIT` stay untranslated by design: they are the
values stored in the database, and translating the display would break the
mapping to stored data.

Strategy rule *details* (`EMA20 82755.35 vs EMA50 80815.55`) are generated by
the engine and remain language-neutral — they are mostly numbers and indicator
names. Rule descriptions are English; see Known limitations.

### Display currency (USD / IDR)

A toggle in the header switches every price between **native**, **USD** and
**IDR**, using a free daily rate from `open.er-api.com`.

Conversion is **display only**, and the rules are enforced in code:

* A converted number always renders with `≈` and a tooltip naming the rate, its
  age and the original amount.
* The native value is **never discarded**.
* **Signals, plans, position sizing and profit/loss are always computed in the
  currency you actually traded in.** A converted figure never enters a
  calculation.
* No rate available, or a currency missing from the rate table → the native
  number is shown with a note, never an approximation.
* Stablecoins (USDT, USDC, …) are mapped to their fiat peg for display, with a
  tooltip stating that USDT is not dollars.

### Positions and plans

Record what you bought and the app answers "what now?" on every refresh:

| Shown per position | Computed from |
|---|---|
| Unrealised P&L, in the asset's own currency | your entry price, quantity and recorded fee |
| Distance to stop, and the loss if it is hit | your stop, current price, your quantity |
| Distance to each target, and the profit there | your targets |
| Progress toward target 1 | entry → current → target |
| **HOLD or SELL, with the rules that decided it** | the same deterministic engine as any signal, told your real entry |

Alerts fire on three position events — **stop breached**, **exit signal**, and
**target reached** — each keyed to the position *and* the bar that triggered it,
so a condition that persists across refreshes alerts once rather than every
cycle.

A position is **never closed automatically.** The app cannot know whether you
executed the sale, so it alerts and waits for you to record the actual fill.

Totals are grouped **by currency and never summed across them**: adding IDR to
USD would need an exchange rate this app does not have and will not invent.

### Signal labels

| Label | Meaning |
|---|---|
| **BUY** | A long entry satisfying every mandatory rule of a strategy. |
| **SELL** | Exit or reduce an existing long. **Not** a short-selling signal. |
| **HOLD** | An open position has no qualifying exit condition. |
| **WAIT** | No valid entry, or evidence is insufficient. |

HOLD and WAIT are states, not events: they are evaluated every run but not
stored as feed entries.

Setup strength (`insufficient` / `weak` / `moderate` / `strong`) counts
satisfied confirmation rules. **It is not a probability of profit.**

---

## Documentation

| Document | Contents |
|---|---|
| [PRODUCT_REQUIREMENTS.md](docs/PRODUCT_REQUIREMENTS.md) | Scope, what is built vs planned |
| [SYSTEM_ARCHITECTURE.md](docs/SYSTEM_ARCHITECTURE.md) | Layers, data flow, decisions and trade-offs |
| [DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) | Every table, key and constraint |
| [DATA_PROVIDER_EVALUATION.md](docs/DATA_PROVIDER_EVALUATION.md) | Provider matrix with real test results |
| [SIGNAL_METHODOLOGY.md](docs/SIGNAL_METHODOLOGY.md) | Strategy rules, risk maths, regime definitions |
| [FORECASTING_AND_EVALUATION.md](docs/FORECASTING_AND_EVALUATION.md) | Baselines, walk-forward, honest results |
| [SECURITY.md](docs/SECURITY.md) | Secrets, auth, injection defence, rotation |
| [TESTING_STRATEGY.md](docs/TESTING_STRATEGY.md) | What is tested and what is not |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Local, VPS and serverless, with scheduling caveats |
| [IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md) | Built / partial / planned |
| [UI_UX_REVIEW.md](docs/UI_UX_REVIEW.md) | Accessibility review, measurements, what was verified and what was not |
| [FUNCTIONAL_REVIEW_FIXES.md](docs/FUNCTIONAL_REVIEW_FIXES.md) | Functional defects found by running the app, and how each was fixed |
| [DEPENDENCY_UPGRADE.md](docs/DEPENDENCY_UPGRADE.md) | Next 16 / Zod 4 / Vitest 5 upgrade: what broke, how it was fixed, how auth was re-verified |

---

## Known limitations

* **No verified free IDX intraday or daily source** (see above).
* **Scalping timeframes are not realistically supported for stocks.** Free stock
  providers cannot deliver 1m data reliably; the app will refuse rather than
  pretend.
* **Nasdaq intraday has no per-bar volume**, so volume-confirmed strategies do
  not run on US intraday data from that provider.
* **Exchange holidays are unknown** unless you configure them; the app says so
  instead of guessing.
* **AI and Telegram integrations are unverified here** — implemented against
  documented request shapes, but no live call has been made without keys.
* **Sample sizes are tiny.** Every performance figure is descriptive, and the
  Evaluation page says so.
* **Strategy rule descriptions are English only.** The surrounding interface
  translates fully, but text produced inside the strategy engine (rule
  descriptions and summaries) is not yet keyed for translation.
* **Forecasting is experimental** and does not influence signals. On the data
  tested, no baseline beat the naive "next close = last close" benchmark.

## Disclaimer

For personal research. Not investment advice. No guarantee of accuracy,
availability or profit. Markets involve risk of loss. Verify every number
against your exchange before acting on it.
