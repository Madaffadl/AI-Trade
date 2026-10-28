> **Historical document.** Written for the earlier multi-market version (US/IDX stocks, Binance, watchlists) before the app was scoped to Indodax on 2026-10-29. Where it disagrees with the README, the README describes the current app.

# System architecture

## Shape

A single Next.js App Router application. No microservices, no message queue, no
Redis, no separate Python service — none was justified by the workload, and each
would add cost and operational surface for one user.

```
┌─ Browser ────────────────────────────────────────────────┐
│  Server Components render data; small client components  │
│  handle interaction (search, AI request, mark-read).     │
└───────────────────────┬──────────────────────────────────┘
                        │  proxy.ts (Node) — auth gate   
┌───────────────────────▼──────────────────────────────────┐
│  Next.js server: pages + /api routes                     │
├──────────────────────────────────────────────────────────┤
│  services                                                │
│   market/service  — cache policy, fetch, fallback        │
│   market/scanner  — watchlist scan rows                  │
│   signals/engine  — rules → risk → identity → storage    │
│   news/ingest     — fetch, sanitise, dedupe, classify    │
│   analysis/service— deterministic + optional AI          │
│   evaluation/     — forward scoring, walk-forward tests  │
│   jobs/refresh    — the scheduled cycle                  │
├──────────────────────────────────────────────────────────┤
│  pure domain (no I/O, no clock, fully testable)          │
│   indicators/ · strategies/ · signals/risk · regime      │
│   evaluation/outcomes · evaluation/metrics · forecast/   │
├──────────────────────────────────────────────────────────┤
│  adapters: providers/{crypto,stocks,news,ai} + http      │
├──────────────────────────────────────────────────────────┤
│  db/driver (SQLite | PostgreSQL) + db/repo               │
└──────────────────────────────────────────────────────────┘
```

The dependency rule: **pure domain code never imports an adapter or the
database.** Strategies receive candles and indicators as arguments. That is what
makes them unit-testable and makes a backtest and a live signal run exactly the
same code.

---

## Key decisions and trade-offs

### One schema, two dialects, no ORM

`src/lib/db/schema.sql` executes unchanged on SQLite and PostgreSQL. It is kept
portable by three rules: only `TEXT` / `INTEGER` / `BIGINT` / `DOUBLE PRECISION`
column types (SQLite resolves these by affinity, PostgreSQL natively); all
timestamps as **epoch milliseconds in BIGINT**, always UTC; application-generated
`TEXT` ids.

The driver exposes `all/get/run/exec` and rewrites `?` placeholders to `$n` for
PostgreSQL.

*Trade-off:* no ORM type-safety or migration tooling; SQL is hand-written and
repository functions are the only place it lives. In exchange: zero database
dependencies, no Docker, no `DATABASE_URL` needed to start, and a schema whose
behaviour is exactly what the file says.

*Why epoch-ms instead of timestamps:* it removes every timezone and dialect
ambiguity at the storage layer. Market data is full of near-identical times that
mean different things, so the schema makes the unit unambiguous and the column
name (`_ms`) states it.

### `node:sqlite` for local development

Node 22+ ships SQLite in core. Local development therefore needs **no database
server and no container** — `npm run db:migrate` just works. Deployment sets
`DATABASE_URL` to any PostgreSQL instance.

*Trade-off:* SQLite's single-writer model is irrelevant for one user and one
worker, but would not survive concurrent writers. That is a real ceiling, and
the Postgres path exists for when it matters.

### Provider adapters declare their own limitations

Each adapter exposes `ProviderCapabilities`: markets, timeframes, delay, quota,
`limitations[]`, and a `verified` boolean. The registry picks the first
configured provider that genuinely covers the requested **exchange and
timeframe**, and when none does it returns a structured explanation naming each
rejected candidate and why.

This is what makes "no provider covers IDX at 1d" a first-class, displayable
result instead of an empty table or a silent substitution.

### Data quality as a domain concept

`DataQuality` (`ok | delayed | stale | insufficient | invalid | unavailable`) is
computed once in the market service and flows into the scanner, the engine, the
analysis service and every page badge. The signal engine refuses anything but
`ok`. The AI layer additionally withholds commentary on non-`ok` data, so the app
never narrates numbers it does not trust.

### Cache policy lives in one place

`market/service.ts` owns it, so no page or job can accidentally spend quota:

1. `DATA_MODE=offline` → database only, never the network.
2. Fresh cache within the per-timeframe TTL (45 s for 1m up to 6 h for 1w) →
   database only.
3. Otherwise fetch, persist, and merge with stored history (so a provider that
   returns a short window, like Nasdaq intraday, still gets full indicator
   warm-up).
4. On failure → serve cached rows **relabelled** `delayed` with the provider
   error attached. The app degrades; it never invents a price.

### AI is a layer, not a dependency

Deterministic analysis always runs. The AI layer is optional, cached
(`AI_CACHE_MINUTES`), capped (`AI_MAX_CALLS_PER_DAY`), and **never triggered by
rendering a page** — only an explicit user action or the scheduled job passes
`allowAiCall: true`. Responses are Zod-validated; a response citing a URL it was
not given, or promising profit, is **discarded**, not displayed with a warning.

The AI output schema deliberately contains **no numeric fields**. The model
cannot emit a price, an indicator value or a probability, because there is
nowhere for one to go.

### Refresh scope is deliberately narrow

The job refreshes watchlist assets only, at **one** timeframe each (the slowest
one the asset's trading style allows that some strategy can actually trade).
Refreshing every asset at every timeframe would multiply provider calls by ~7 and
exhaust free quotas in minutes.

---

## Request flows

**Page render (no quota spent):** Server Component → service → repo → DB.
Cached candles within TTL mean navigation costs nothing.

**Scheduled refresh:** worker/cron → `runRefresh` → per watchlist asset:
`getSeries` → quality gate → indicators + regime → each eligible strategy →
risk sizing → `insertSignalIfNew` → `dispatchAlert` (only on creation) →
threshold checks → expiry sweep → `job_runs` row.

**AI analysis:** user clicks → `POST /api/analysis` with `allowAiCall: true` →
cache check → daily cap check → quality check → prompt built from deterministic
facts with article text fenced as untrusted → provider → Zod validation →
persisted in `analysis_runs`.

---

## Security boundaries

* `proxy.ts` (Node.js runtime; renamed from `middleware.ts` in Next 16) gates every route except `/login`, `/api/auth/login`
  and `/api/health`. With no `AUTH_PASSWORD` it serves **localhost only** and
  refuses remote requests outright.
* `/api/cron/*` authenticates with a bearer token instead of a cookie, since a
  scheduler has none.
* `server-only` is imported by every module that touches secrets or the
  database, so a client import is a build error rather than a leak.
* Outbound requests go through one guarded client that blocks non-http(s)
  schemes and private/loopback hosts (SSRF), caps response size, and applies
  timeouts and bounded retries.

Details in [SECURITY.md](SECURITY.md).

---

## One tooltip element, not seventy

`components/hint.tsx` renders triggers that carry their text in `data-hint` and
no panel at all. A single client component (`HintLayer`, mounted once in the
layout) listens for pointer and focus events and positions one shared panel.

Two earlier attempts failed for instructive reasons:

1. **Pure CSS (`group-hover`)** rendered a panel per trigger. It cannot measure
   the viewport, so a centred panel was clipped whenever the trigger sat near an
   edge — measured at 18 of 72 tooltips on the Evaluation page.
2. **Hand-tagging each call site with `align="start" | "end"`** fixed the
   measured cases but is brittle: it silently breaks whenever a table column
   moves, and it does not scale to 70+ hints on one page.

The shared layer uses `position: fixed`, which also escapes the
`overflow-x: auto` on scrolling tables that would otherwise clip an absolutely
positioned panel. `title` is kept on every trigger as a no-JavaScript fallback.

## i18n without a library

`lib/i18n/en.ts` defines the message shape; `id.ts` is typed as `Messages` and
therefore cannot omit a key. That inverts the usual trade-off: a runtime i18n
framework resolves missing keys by printing the key itself, whereas here the
build fails.

Two constraints shaped the design:

1. **Interpolation is functions, not string templates** (`subtitle(count, mode)`),
   so translators control word order instead of receiving pre-concatenated
   fragments.
2. **Client components never receive the dictionary.** React cannot serialise
   functions across the server/client boundary, so `lib/i18n/client-labels.ts`
   builds plain-string bags on the server. Messages needing a runtime value are
   pre-rendered as templates containing a `{token}`, substituted client-side by
   `fill()`. This keeps one dictionary as the single source of truth rather than
   duplicating wording for client components.

This was found the hard way: passing `Messages` straight to the position form
type-checked cleanly and then failed at runtime with "Functions cannot be passed
directly to Client Components".

## FX is display-only, by construction

`lib/fx/service.ts` converts prices for display and nothing else. The rule is
structural rather than a convention: `convertForDisplay()` returns a
`ConvertedMoney` object that always carries the **native** value and currency
alongside the converted one, and the `<Money>` component renders `≈` plus a
tooltip whenever a conversion happened. Nothing in `indicators/`, `strategies/`,
`signals/` or `positions/` imports the FX module at all, so a converted number
has no path into a calculation. When a rate is missing the native value is shown
with a note — the app never approximates a price it cannot convert.

Cross-currency totals are deliberately **not** produced: the portfolio page
groups by currency instead of summing IDR and USD together.

## Deliberate omissions

| Not built | Why |
|---|---|
| Order execution | Explicitly out of scope. No brokerage credentials exist anywhere in the codebase. |
| Portfolio management | Deferred until the MVP is stable, per the spec. |
| Automated paper trading | Forward signal evaluation covers the same question more honestly, without implying fills. |
| ML price models | Baselines do not beat naive yet. A complex model must first clear that bar. |
| Redis / queues / microservices | One user, one worker. Nothing justifies the cost or complexity. |
| WebSocket streaming | Polling at the configured intervals is sufficient and far cheaper in quota and complexity. |
