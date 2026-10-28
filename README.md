# AI Trade — personal Indodax trading assistant

A private, single-user app for **Indodax spot IDR pairs**. Open it and it
answers one question: **what should I do right now?**

* **BUY NOW** — a setup is live and buyable at or below its maximum entry,
* **WAIT FOR ENTRY** — a setup is one step away; it names the exact trigger
  ("buy only if a 1-hour candle closes above Rp …"),
* **NO TRADE RIGHT NOW** — nothing passes every rule, with the reasons.

Every plan carries the entry and maximum entry (never chase), stop-loss,
targets, the IDR amount sized from your capital and risk %, Indodax's real
costs, net reward:risk, and a sell-by time. Numbers come from deterministic
code; the optional AI layer only explains them.

**It never places trades and holds no exchange credentials.** It is a
personal research tool, not investment advice. Nothing here is evidence that
any strategy is profitable.

---

## Status (2026-10-29)

| Piece | Status |
|---|---|
| Indodax universe: liquid IDR pairs, spread/volume filters, real fees and order increments | **Built**, verified live |
| Plan engine: 1h & 4h entries, 4h / daily trend filter, wait-for-entry triggers, sizing, costs, ranking | **Built**, unit-tested |
| Home decision screen, Opportunities, plan detail, Capital & risk settings | **Built** |
| Positions you actually hold, with hold/sell plan, sell-by time and alerts | **Built** |
| News (CoinDesk, Federal Reserve) and AI explanations (free Gemini → Groq chain) | **Built** |
| Paper trading: auto-simulation of every BUY NOW, manual "Simulate this plan", journal, live-price fills | **Built**, verified against live Indodax prices |
| Strategy validation on Indodax history (plan-level backtest, in/out-of-sample, random and buy-and-hold benchmarks) + Performance page | **Built** — `npm run validate` |
| Worker: hourly scan after each candle close, live price check every minute, in-app alerts, AI commentary for the top setups | **Built** — `npm run worker` / `npm run dev:all` |
| Telegram | Implemented earlier, unverified — last phase |

**Honest limits right now**

* Every strategy is labelled **Experimental**: validation (2026-10-29, 18
  pairs) found no reliable edge after Indodax costs. Out-of-sample, per trade:

  | Strategy | Trades | Net expectancy | Profit factor | In-sample |
  |---|---|---|---|---|
  | Trend momentum 4h (new) | 79 | +0.26% | 1.06 | −0.70% (49) |
  | Trend pullback 1h (v2) | 48 | +0.03% | 1.01 | −1.70% (63) |
  | Trend pullback 4h (v2) | 14 | −0.27% | 0.85 | −1.09% (26) |
  | Breakout 1h | 8 | −0.78% | 0.81 | −7.89% (6) |
  | Breakout 4h | 22 | −2.00% | 0.57 | −1.42% (10) |

  Random entries lost 0.8–0.9% per trade (≈ the costs). The two small
  positive results fail the profit-factor bar (> 1.1) and were negative in the
  earlier, in-sample months, so they are not evidence of an edge. Holding the
  same coins gained 25–42% over those periods. Parameters were **not** tuned to
  these results.
* A round trip on Indodax costs about **0.7–1.1%** (0.2% taker each side,
  ~0.21% sale tax, measured spread). Setups whose target sits too close to
  that are rejected — on 1-hour breakouts that is most of them.
* Prices checked more than 10 minutes ago, or candles from a scan more than
  75 minutes old, show **no action**. Without the worker that means pressing
  **Refresh now**; with it, prices are re-checked every minute.

---

## Quick start

```bash
cp .env.example .env.local    # then add your free GEMINI_API_KEY / GROQ_API_KEY (optional)
npm install
npm run scan                  # first scan of Indodax (applies migrations itself)
npm run dev:all               # the app + the worker (monitoring and alerts) together
```

Open <http://localhost:3000>. Set your capital and risk in **Settings →
Capital & risk** (defaults: Rp1,000,000 and 1% per trade).

Requirements: **Node 22+** (built-in `node:sqlite`). No database server, no
Docker, no paid service.

`npm run dev` alone starts only the app: prices then update only when you
press **Refresh now**, and no alerts are raised. To run the worker on its own
next to an app that is already running:

```bash
npm run worker
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev:all` | App and worker together (Ctrl+C stops both) |
| `npm run dev` / `npm run build` / `npm start` | Development server / production build / serve |
| `npm run scan` | One full cycle (scan + simulations + position review), printed: decision, plans, rejected setups, simulation account |
| `npm run scan:universe` | Which pairs are scanned, with volume, spread, fee, minimum order |
| `npm run refresh` | The same cycle with a short report (what the worker runs) |
| `npm run worker` | The scheduler: hourly scan, live monitor every minute, alerts, AI commentary, daily validation |
| `npm run providers:verify` | One real request to Indodax, each news feed and each AI model |
| `npm run validate` | Backfill Indodax history and validate every strategy x timeframe (`--no-backfill` to reuse stored candles) |
| `npm run evaluate` | Score past signals against the candles that followed |
| `npm run db:migrate` | Apply the schema and pending migrations |
| `npm test` / `npm run typecheck` / `npm run lint` | Checks |

## How a plan is made

1. **Universe** — from Indodax's `/api/ticker_all` and `/api/pairs`: IDR pairs,
   no stablecoins, open for trading, ≥ Rp1 billion 24h turnover, spread ≤ 0.5%
   (BTC and ETH always included). All filters are settings.
2. **Strategies** on closed candles only — trend pullback and Donchian
   breakout on **1h** (needs the 4h trend up) and **4h** (needs the daily
   trend up), and trend momentum (new 10-bar closing high, 2.5 ATR stop) on
   **4h** only. One condition short of firing = a *wait-for-entry* trigger.
3. **Plan** — entry, maximum entry (¼ ATR above the reference, and never past
   the price where net reward:risk drops below your minimum), stop, targets,
   size = min(risk budget, per-position cap, free cash), rounded down to the
   pair's quantity step and ≥ Rp10,000. Costs: taker fee from `/api/pairs`,
   sale tax and levies from your settings, half the measured spread per side.
4. **State** against the live order book: BUY NOW / WAIT FOR ENTRY /
   NOT ELIGIBLE / MISSED / INVALIDATED / EXPIRED / DATA STALE.
5. **Ranking** — documented weighted score (validation, net R:R, liquidity,
   trend strength, closeness to entry, spread). Not a probability of profit.

Rules the code enforces: closed bars only; stale data shows no action; a gap
is never filled with an invented candle; AI responses that promise profit or
cite a source they were not given are rejected (English and Indonesian).

## Worker and alerts

`npm run worker` is a plain long-running Node process (no cron, no queue):

| When | What |
|---|---|
| Hourly, 90 s after each candle close (Indodax closes 1h candles on the hour, 4h at 07/11/15/19/23/03 WIB, daily at 07:00 WIB) | The full scan |
| Every minute in between | One `ticker_all` request → setup states (BUY NOW / WAIT / missed / failed), the home decision, paper trades, the positions you recorded |
| After each scan | AI commentary for the top 2 setups — calls 70 s apart, an equivalent setup explained in the last 3 h reuses its text |
| Daily | Strategy validation (backfills only new candles) |
| Every 30 / 60 min | News / signal evaluation |

The scan and the monitor take a database lock, so the app's **Refresh now**
and the worker never move the same paper trade twice. Stopping the worker
(Ctrl+C) releases it.

**Alerts** (Notifications page, Telegram later) — one per event, never
repeated by the minute-by-minute checks:

* a setup becomes **BUY NOW** (labelled experimental while the strategy is
  not validated), or is one trigger away (**Get ready**, at most once per
  entry window);
* a setup that was announced as buyable fails, runs to its target without
  you, or expires (**Do not buy any more**);
* a paper trade buys, sells (stop, target 1, sell-by time) or expires unfilled;
* a position you recorded reaches its stop (urgent), target 1 or sell-by
  time, or its strategy gives an exit signal.

## Simulation (paper trading)

A virtual account (starting capital in Settings) follows the plans before any
real money does. Every BUY NOW setup is simulated automatically (can be turned
off), and any actionable plan can be simulated by hand.

* Entry: the live ask, only at or below the plan's maximum entry; otherwise the
  order rests (at the maximum entry, or until the trigger candle closes).
* Stop: sells at the live bid once the bid reaches it — a gap fills lower.
  Target 1 fills at its price. At the sell-by time it sells at the bid.
* While nothing was running, closed 1h candles are replayed; a stop and a
  target in the same candle count as the stop.
* Fees, sale tax and levies are charged; the spread is not charged twice
  because fills use the real bid/ask. Sizing uses the simulated equity and cash.

Simulated trades live in their own table and never mix with real positions.

## AI (optional, free by default)

The worker writes commentary for the best setups after each scan, so a page
never waits on a model. The model is given the plan's numbers and its
validation label and asked to explain it — what it bets on, what would make
a careful trader skip it, and (for an experimental strategy) that it is for
simulation only. It never sets a price.

`AI_PROVIDER=gemini,groq` is a fallback chain; each `*_MODEL` may list several
models. Overloaded or rate-limited models are skipped for a while (90 s after a
429, 5 min after a 503, 10 min after a timeout). Paid adapters (Anthropic,
OpenAI, OpenRouter) remain in the code but are never called unless added to
`AI_PROVIDER`. Commentary follows the interface language.

## Documentation

The files in `docs/` were written for the earlier multi-market version (US/IDX
stocks, Binance, watchlists). They are kept as history; where they disagree
with this README, this README describes the current app.

## Disclaimer

For personal research. Not investment advice. No guarantee of accuracy,
availability or profit. Trading crypto can lose money, including the full
amount allocated, and a stop-loss is not guaranteed to fill at its price.
