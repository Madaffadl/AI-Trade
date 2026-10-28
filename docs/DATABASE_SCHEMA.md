> **Historical document.** Written for the earlier multi-market version (US/IDX stocks, Binance, watchlists) before the app was scoped to Indodax on 2026-10-29. Where it disagrees with the README, the README describes the current app.

# Database schema

Source of truth: [`src/lib/db/schema.sql`](../src/lib/db/schema.sql). Applied by
`npm run db:migrate`, which is idempotent (every statement uses
`IF NOT EXISTS`).

---

## Portability contract

One DDL file executes unchanged on **SQLite** (local) and **PostgreSQL**
(deployed), because:

| Rule | Reason |
|---|---|
| Only `TEXT` / `INTEGER` / `BIGINT` / `DOUBLE PRECISION` column types | SQLite resolves these by type affinity; PostgreSQL accepts them natively. No `SERIAL`, `AUTOINCREMENT`, `JSONB`, `TIMESTAMPTZ` or `UUID`. |
| Timestamps are **epoch milliseconds, UTC, in `BIGINT`** | Removes every timezone and dialect ambiguity. Columns ending `_ms` are always epoch-ms UTC. |
| Identifiers are application-generated `TEXT` (`crypto.randomUUID()`) | No dialect-specific sequences or UUID defaults. |
| Booleans are `INTEGER` 0/1 | Portable across both. |
| Structured payloads are `TEXT` containing JSON | `jsonb` is PostgreSQL-only. |
| Upserts use `ON CONFLICT (...) DO UPDATE` | SQLite ≥ 3.24 and PostgreSQL ≥ 9.5. |

Enforced by a test: `tests/database.test.ts` strips comments from the DDL and
asserts none of the forbidden types appear in executable SQL.

---

## Tables

### Reference data

**`exchanges`** — `id` (PK, e.g. `BINANCE`, `US`, `IDX`), `name`, `asset_class`,
`country`, `timezone` (IANA), `continuous` (1 for 24/7 crypto), `created_at_ms`.

**`assets`** — `id` (PK uuid), `symbol`, `display_name`, `asset_class`,
`exchange_id` → `exchanges`, `currency`, `tick_size`, `lot_size`,
`min_notional`, `active`, `created_at_ms`.
*Unique:* `(exchange_id, symbol)`. *Index:* `(asset_class, active)`.

The microstructure columns are **nullable on purpose**: `NULL` means *unknown*,
which the UI discloses and which makes position sizing refuse to round to an
invented increment.

### Market data

**`market_candles`** — PK `(asset_id, timeframe, open_time_ms)`.

| Column | Note |
|---|---|
| `open_time_ms` | Candle **start**, exchange clock, UTC ms |
| `close_time_ms` | Candle **end** — distinct from the retrieval time |
| `open/high/low/close` | `DOUBLE PRECISION` |
| `volume` | **Nullable.** `NULL` = the provider supplies none. Never 0-as-unknown |
| `provider` | Which adapter produced the row (data lineage) |
| `fetched_at_ms` | When **we** retrieved it — deliberately a separate column |
| `is_partial` | 1 while the bar is still forming; excluded from strategy rules |
| `quality` | `ok` / `suspect` / `repaired` |

*Index:* `(asset_id, timeframe, open_time_ms DESC)` — the hot path for every
chart, scan and backtest.

The composite PK is what makes re-fetching safe: an overlapping request upserts
rather than duplicating.

### Watchlists

**`watchlists`** — `id`, `name` (unique), `is_default`, `created_at_ms`.
**`watchlist_assets`** — PK `(watchlist_id, asset_id)`, plus `trading_style`,
`added_at_ms`, `notes`.

### News

**`news_articles`** — `id`, **`dedupe_key` (unique)**, `headline`, `url`,
`publisher`, `feed_id`, `published_at_ms`, `event_at_ms`, `fetched_at_ms`,
`summary`, `category`, `sentiment`, `sentiment_src`, `impact`, `raw_excerpt`.

Three separate time columns on purpose: when the **article** was published, when
the **event** occurred (only when a source states it; otherwise `NULL` — it is
never assumed equal to the publication date), and when **we** fetched it.

`dedupe_key` = `sha256(publisher | normalised headline)`, so the same story
re-published under a different URL collapses to one row. `sentiment_src` records
`keyword` so the UI can show that sentiment is a heuristic, not analysis.

**`news_asset_impacts`** — PK `(article_id, asset_id)`, plus `relevance` and
`match_reason` — the matched token is stored so every link is auditable.

### Analysis

**`technical_indicator_snapshots`** — unique
`(asset_id, timeframe, candle_open_ms)`; stores deterministic indicator values,
`regime` and `data_quality` for a specific bar.

**`analysis_runs`** — `id`, asset/timeframe/style, `started_at_ms`,
`finished_at_ms`, `latest_candle_ms`, `ai_provider` (`deterministic` when no
model ran), `ai_model`, `ai_status` (`ok|skipped|error|cached`), `ai_error`,
`analysis_json` (schema-validated), `strategy_version`, `data_quality`.

`ai_provider` is the column that lets the UI separate computed fact from model
commentary. It also powers the AI cache lookup and the daily call cap.

### Strategies and signals

**`strategy_definitions`** — PK `(id, version)`, with `parameters_json`,
`warmup_bars`, `enabled`.

**`trading_signals`** — `id`, **`signal_key` (unique)**, asset/timeframe/style,
`strategy_id` + `strategy_version`, `action`, `strength`, `generated_at_ms`,
`candle_open_ms`, `data_fetched_ms`, `price_at_signal`, entry/stop/target
levels, `risk_reward`, `position_size`, `risk_amount`, `regime`,
`data_quality`, `reasons_json`, `risks_json`, `invalidation_json`,
`indicators_json`, `news_ids_json`, `analysis_run_id`, `status`, `closed_at_ms`.

`signal_key` = hash of (strategy, version, asset, timeframe, action, **trigger
bar**). The unique constraint is the duplicate-notification defence: re-running
the engine on unchanged data cannot insert a second row.

Three distinct timestamps are kept: when the signal was generated, which bar
triggered it, and when the underlying data was retrieved.

*Indexes:* `(generated_at_ms DESC)` for the feed,
`(asset_id, timeframe, generated_at_ms DESC)` for asset pages,
`(status, generated_at_ms DESC)` for invalidation sweeps.

**`signal_evaluations`** — unique `(signal_id, horizon_bars)`; `outcome`,
`exit_price`, `exit_reason`, `max_favorable_excursion`,
`max_adverse_excursion`, `return_pct`, `return_pct_net`, `r_multiple`,
`fee_assumption_bps`, `slippage_assumption_bps`, **`overlaps_prior`**.

The unique constraint allows re-evaluation to update in place as a horizon
progresses. `overlaps_prior` flags trades that overlapped an earlier open signal
so they can be excluded from "independent sample" statistics. The cost
assumptions are stored **per evaluation**, so changing a default later does not
silently rewrite past results.

### Alerts

**`alerts`** — `id`, **`dedupe_key` (unique)**, `kind`, `severity`, `title`,
`body`, optional `asset_id` / `signal_id` / `article_id`, `created_at_ms`,
`read_at_ms`, `payload_json`.

`dedupe_key` describes the alert-worthy **state** (`new_signal:<id>`), never the
refresh event that observed it.

**`notification_deliveries`** — unique `(alert_id, channel)`; `status`
(`pending|sent|failed|suppressed`), `attempted_at_ms`, `delivered_at_ms`,
`error`. One row per channel per alert makes double-sending structurally
impossible.

**`price_thresholds`** — unique `(asset_id, direction, price)`; `active`,
`triggered_at_ms` so a crossing fires once.

### Positions (what you actually hold)

**`positions`** — the bridge between advice and reality.

| Column group | Purpose |
|---|---|
| `venue`, `quantity`, `entry_price`, `entry_at_ms`, `entry_fee` | the fill as it really happened, at Indodax / Pluang / Stockbit |
| `stop_loss`, `take_profit_1`, `take_profit_2`, `timeframe`, `trading_style` | the plan being followed, **copied at open time** so a later strategy change cannot rewrite the plan a position was opened on |
| `strategy_id`, `strategy_version`, `opened_from_signal_id` | provenance: which signal inspired the trade |
| `status`, `exit_price`, `exit_at_ms`, `exit_fee`, `exit_reason`, `realized_pnl`, `realized_pnl_pct` | the realised outcome, net of both recorded fees |

*Indexes:* `(status, asset_id)` for the engine's open-position lookup,
`(entry_at_ms DESC)` for the history view.

`venue` is **metadata only** — the price source is always determined by the
asset's exchange, never by where you happened to buy.

A position is never closed by the app. `realized_pnl` is only written when the
user records the sale they actually made.

### Instrument catalogue

**`instrument_catalog`** — PK `(exchange_id, symbol)`; cached reference data
from every provider (symbol, name, currency, and where available `last_price`,
`market_cap`, `change_pct`, lot/tick/min-notional). Refreshed on demand, never
on a page render: it pulls tens of megabytes.

Price and cap columns are nullable because most providers do not supply them —
a missing value stays missing rather than being guessed at. *Index:*
`(asset_class, exchange_id)` and `(market_cap)` for the cap-band filter.

### Operations

**`provider_status`** — PK `(provider, operation)`; `last_ok_ms`,
`last_error_ms`, `last_error`, `consecutive_failures`, `calls_today`,
`calls_day_key` (UTC `YYYY-MM-DD`, resets the counter), `rate_limited_until_ms`.

**`application_settings`** — `key` (PK), `value_json`, `updated_at_ms`.
**Non-secret preferences only.** API keys and tokens live exclusively in
environment variables; the schema file states this and a test asserts the table
is empty of credentials.

**`job_runs`** — `id`, `job`, `started_at_ms`, `finished_at_ms`, `status`
(`running|ok|partial|error`), `summary_json`, `error`. Surfaced on Settings so
"last refresh" is a fact, not an assumption.

---

## Derived data policy

Indicators are **recomputed from candles** rather than stored on the hot path.
They are persisted only where there is a clear auditability benefit: inside
`trading_signals.indicators_json` (so a past signal can be explained with the
exact values it saw, even after the strategy changes) and in
`technical_indicator_snapshots`.

## Retention

Nothing is auto-deleted. Rough growth: one asset at 1d ≈ 365 rows/year; at 1h
≈ 8,760 rows/year — trivial for SQLite at this scale. Candles and news are
re-fetchable; **signals and evaluations are the only irreplaceable history**, so
back those up before any destructive maintenance. A retention job is listed as
planned in the roadmap.
