-- =============================================================================
-- AI Trade - relational schema
--
-- PORTABILITY CONTRACT
-- This single DDL file must execute unchanged on both SQLite (local dev) and
-- PostgreSQL (deployment). To achieve that:
--   * Only TEXT / INTEGER / BIGINT / DOUBLE PRECISION column types are used.
--     SQLite resolves these by type affinity; PostgreSQL accepts them natively.
--   * Every timestamp is stored as epoch MILLISECONDS in a BIGINT column, always
--     UTC. This removes all timezone/dialect ambiguity. Column names ending in
--     `_ms` are always epoch-millisecond UTC values.
--   * Identifiers are application-generated TEXT (crypto.randomUUID) or natural
--     keys. No dialect-specific sequences or UUID defaults.
--   * Booleans are INTEGER 0/1.
--   * Structured payloads are TEXT containing JSON (not jsonb) for portability.
--   * Upserts use `ON CONFLICT (...) DO UPDATE`, supported by SQLite >= 3.24
--     and PostgreSQL >= 9.5.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exchanges (
  id              TEXT PRIMARY KEY,            -- 'BINANCE', 'NASDAQ', 'IDX'
  name            TEXT NOT NULL,
  asset_class     TEXT NOT NULL,               -- 'crypto' | 'stock'
  country         TEXT,
  timezone        TEXT NOT NULL,               -- IANA tz, e.g. 'Asia/Jakarta'
  continuous      INTEGER NOT NULL DEFAULT 0,  -- 1 = 24/7 trading (crypto)
  created_at_ms   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id              TEXT PRIMARY KEY,            -- uuid
  symbol          TEXT NOT NULL,               -- provider-agnostic, e.g. 'BTCUSDT', 'AAPL', 'BBCA'
  display_name    TEXT NOT NULL,
  asset_class     TEXT NOT NULL,               -- 'crypto' | 'stock'
  exchange_id     TEXT NOT NULL REFERENCES exchanges(id),
  currency        TEXT NOT NULL,               -- quote currency: 'USDT', 'USD', 'IDR'
  -- Market microstructure. NULL means "unknown" and MUST be disclosed in the UI
  -- rather than silently assumed; position sizing refuses to round to an
  -- unknown lot/tick size.
  tick_size       DOUBLE PRECISION,
  lot_size        DOUBLE PRECISION,
  min_notional    DOUBLE PRECISION,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at_ms   BIGINT NOT NULL,
  UNIQUE (exchange_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_assets_class ON assets (asset_class, active);

-- ---------------------------------------------------------------------------
-- Market data
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS market_candles (
  asset_id        TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  timeframe       TEXT NOT NULL,               -- '1m','5m','15m','1h','4h','1d','1w'
  open_time_ms    BIGINT NOT NULL,             -- candle START (exchange clock, UTC ms)
  close_time_ms   BIGINT NOT NULL,             -- candle END (UTC ms); distinct from open
  open            DOUBLE PRECISION NOT NULL,
  high            DOUBLE PRECISION NOT NULL,
  low             DOUBLE PRECISION NOT NULL,
  close           DOUBLE PRECISION NOT NULL,
  volume          DOUBLE PRECISION,            -- NULL = provider did not supply volume
  trades          BIGINT,
  provider        TEXT NOT NULL,               -- which adapter produced this row
  -- fetched_at_ms is when WE retrieved the row. It is deliberately a separate
  -- column from open_time_ms/close_time_ms so staleness and data lineage can be
  -- reasoned about independently of market time.
  fetched_at_ms   BIGINT NOT NULL,
  -- 1 while the candle's period is still in progress. Partial candles must not
  -- be used to confirm a closed-bar strategy rule.
  is_partial      INTEGER NOT NULL DEFAULT 0,
  quality         TEXT NOT NULL DEFAULT 'ok',  -- 'ok' | 'suspect' | 'repaired'
  PRIMARY KEY (asset_id, timeframe, open_time_ms)
);

CREATE INDEX IF NOT EXISTS idx_candles_lookup ON market_candles (asset_id, timeframe, open_time_ms DESC);

-- ---------------------------------------------------------------------------
-- News and events
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS news_articles (
  id              TEXT PRIMARY KEY,
  -- Stable hash of (normalised title + publisher). Used for deduplication of
  -- the same story re-published or re-fetched.
  dedupe_key      TEXT NOT NULL UNIQUE,
  headline        TEXT NOT NULL,
  url             TEXT NOT NULL,               -- original source URL, validated http(s)
  publisher       TEXT NOT NULL,
  feed_id         TEXT NOT NULL,
  published_at_ms BIGINT,                      -- when the ARTICLE was published
  event_at_ms     BIGINT,                      -- when the EVENT occurred, if different/known
  fetched_at_ms   BIGINT NOT NULL,             -- when WE retrieved it
  summary         TEXT,                        -- short extract from the feed, sanitised
  category        TEXT,                        -- monetary_policy|earnings|regulation|...
  sentiment       TEXT,                        -- bullish|bearish|neutral|unclear
  sentiment_src   TEXT,                        -- 'keyword' (deterministic) | 'ai'
  impact          TEXT,                        -- high|medium|low|unknown
  raw_excerpt     TEXT                         -- sanitised plain text, injection-stripped
);

CREATE INDEX IF NOT EXISTS idx_news_published ON news_articles (published_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_news_feed ON news_articles (feed_id, published_at_ms DESC);

CREATE TABLE IF NOT EXISTS news_asset_impacts (
  article_id      TEXT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  asset_id        TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  relevance       DOUBLE PRECISION NOT NULL,   -- 0..1, deterministic keyword match score
  match_reason    TEXT NOT NULL,               -- which token matched; keeps it auditable
  PRIMARY KEY (article_id, asset_id)
);

-- ---------------------------------------------------------------------------
-- Analysis
-- ---------------------------------------------------------------------------

-- technical_indicator_snapshots was removed.
--
-- It was declared here from the first migration and never read or written by
-- any code path — a table that advertises an audit trail the app does not
-- actually keep. Indicators are recomputed deterministically from stored
-- candles whenever they are needed, so the snapshot added no capability, only
-- the false impression of one. Existing databases keep the empty table
-- harmlessly; it is simply no longer created.


CREATE TABLE IF NOT EXISTS analysis_runs (
  id                TEXT PRIMARY KEY,
  asset_id          TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  timeframe         TEXT NOT NULL,
  trading_style     TEXT NOT NULL,
  started_at_ms     BIGINT NOT NULL,
  finished_at_ms    BIGINT,
  latest_candle_ms  BIGINT,                    -- market-data timestamp the run saw
  -- 'deterministic' when no LLM was used; otherwise the provider name. This is
  -- what lets the UI separate computed fact from AI commentary.
  ai_provider       TEXT NOT NULL DEFAULT 'deterministic',
  ai_model          TEXT,
  ai_status         TEXT NOT NULL DEFAULT 'skipped', -- ok|skipped|error|cached
  ai_error          TEXT,
  analysis_json     TEXT,                      -- schema-validated structured output
  strategy_version  TEXT NOT NULL,
  data_quality      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analysis_asset ON analysis_runs (asset_id, timeframe, started_at_ms DESC);

-- ---------------------------------------------------------------------------
-- Strategies and signals
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS strategy_definitions (
  id                TEXT NOT NULL,             -- 'trend_follow_ema'
  version           TEXT NOT NULL,             -- '1.0.0'
  name              TEXT NOT NULL,
  description       TEXT NOT NULL,
  asset_classes     TEXT NOT NULL,             -- JSON array
  timeframes        TEXT NOT NULL,             -- JSON array
  parameters_json   TEXT NOT NULL,
  warmup_bars       INTEGER NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at_ms     BIGINT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS trading_signals (
  id                TEXT PRIMARY KEY,
  -- Deterministic identity of a setup: hash(strategy,version,asset,timeframe,
  -- action,trigger bar). Re-evaluating an unchanged setup yields the same key,
  -- which is what suppresses duplicate notifications.
  signal_key        TEXT NOT NULL UNIQUE,
  asset_id          TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  timeframe         TEXT NOT NULL,
  trading_style     TEXT NOT NULL,
  strategy_id       TEXT NOT NULL,
  strategy_version  TEXT NOT NULL,
  action            TEXT NOT NULL,             -- BUY|SELL|HOLD|WAIT
  strength          TEXT NOT NULL,             -- insufficient|weak|moderate|strong
  generated_at_ms   BIGINT NOT NULL,
  candle_open_ms    BIGINT NOT NULL,           -- trigger bar (market time)
  data_fetched_ms   BIGINT NOT NULL,           -- lineage: when the data was pulled
  price_at_signal   DOUBLE PRECISION NOT NULL,
  entry_low         DOUBLE PRECISION,
  entry_high        DOUBLE PRECISION,
  stop_loss         DOUBLE PRECISION,
  take_profit_1     DOUBLE PRECISION,
  take_profit_2     DOUBLE PRECISION,
  risk_reward       DOUBLE PRECISION,
  position_size     DOUBLE PRECISION,
  risk_amount       DOUBLE PRECISION,
  regime            TEXT NOT NULL,
  data_quality      TEXT NOT NULL,
  reasons_json      TEXT NOT NULL,             -- deterministic rule outcomes
  risks_json        TEXT NOT NULL,
  invalidation_json TEXT NOT NULL,
  indicators_json   TEXT NOT NULL,             -- indicator values at trigger time
  news_ids_json     TEXT,                      -- supporting article ids
  analysis_run_id   TEXT REFERENCES analysis_runs(id),
  status            TEXT NOT NULL DEFAULT 'active', -- active|invalidated|expired|closed
  closed_at_ms      BIGINT
);

CREATE INDEX IF NOT EXISTS idx_signals_feed ON trading_signals (generated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_signals_asset ON trading_signals (asset_id, timeframe, generated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_signals_status ON trading_signals (status, generated_at_ms DESC);

CREATE TABLE IF NOT EXISTS signal_evaluations (
  id                  TEXT PRIMARY KEY,
  signal_id           TEXT NOT NULL REFERENCES trading_signals(id) ON DELETE CASCADE,
  evaluated_at_ms     BIGINT NOT NULL,
  horizon_bars        INTEGER NOT NULL,        -- fixed evaluation horizon per strategy
  horizon_end_ms      BIGINT NOT NULL,
  bars_observed       INTEGER NOT NULL,
  -- 'pending' until the horizon completes or a level is hit. A brief favourable
  -- excursion is NOT counted as a win; see docs/FORECASTING_AND_EVALUATION.md
  outcome             TEXT NOT NULL,           -- pending|target_hit|stop_hit|timeout_gain|timeout_loss|invalidated|unevaluable
  exit_price          DOUBLE PRECISION,
  exit_reason         TEXT,
  max_favorable_excursion DOUBLE PRECISION,
  max_adverse_excursion   DOUBLE PRECISION,
  return_pct          DOUBLE PRECISION,        -- gross
  return_pct_net      DOUBLE PRECISION,        -- after assumed fees + slippage
  r_multiple          DOUBLE PRECISION,        -- net return / initial risk
  fee_assumption_bps  DOUBLE PRECISION NOT NULL,
  slippage_assumption_bps DOUBLE PRECISION NOT NULL,
  -- Signals overlapping an earlier open signal on the same asset+strategy are
  -- flagged so they are not counted as independent trades.
  overlaps_prior      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (signal_id, horizon_bars)
);

CREATE INDEX IF NOT EXISTS idx_eval_outcome ON signal_evaluations (outcome, evaluated_at_ms DESC);

-- ---------------------------------------------------------------------------
-- Alerts and notifications
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS alerts (
  id              TEXT PRIMARY KEY,
  -- Stable key for the alert-worthy STATE, not the refresh event. Repeated
  -- evaluation of an unchanged state reuses this key and is suppressed.
  dedupe_key      TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,               -- new_signal|signal_invalidated|price_threshold|news|provider_failure
  severity        TEXT NOT NULL,               -- info|warning|critical
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  asset_id        TEXT REFERENCES assets(id) ON DELETE SET NULL,
  signal_id       TEXT REFERENCES trading_signals(id) ON DELETE SET NULL,
  article_id      TEXT REFERENCES news_articles(id) ON DELETE SET NULL,
  created_at_ms   BIGINT NOT NULL,
  read_at_ms      BIGINT,
  payload_json    TEXT
);

CREATE INDEX IF NOT EXISTS idx_alerts_feed ON alerts (created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unread ON alerts (read_at_ms, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id              TEXT PRIMARY KEY,
  alert_id        TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,               -- in_app|telegram
  status          TEXT NOT NULL,               -- pending|sent|failed|suppressed
  attempted_at_ms BIGINT NOT NULL,
  delivered_at_ms BIGINT,
  error           TEXT,
  UNIQUE (alert_id, channel)
);

-- ---------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS provider_status (
  provider        TEXT NOT NULL,
  operation       TEXT NOT NULL,               -- 'candles','quote','news','ai'
  last_ok_ms      BIGINT,
  last_error_ms   BIGINT,
  last_error      TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  calls_today     INTEGER NOT NULL DEFAULT 0,
  calls_day_key   TEXT,                        -- 'YYYY-MM-DD' UTC, resets the counter
  rate_limited_until_ms BIGINT,
  PRIMARY KEY (provider, operation)
);

-- Non-secret application settings only. API keys and tokens live exclusively in
-- environment variables and are never written to this table.
CREATE TABLE IF NOT EXISTS application_settings (
  key             TEXT PRIMARY KEY,
  value_json      TEXT NOT NULL,
  updated_at_ms   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_runs (
  id              TEXT PRIMARY KEY,
  job             TEXT NOT NULL,
  started_at_ms   BIGINT NOT NULL,
  finished_at_ms  BIGINT,
  status          TEXT NOT NULL,               -- running|ok|partial|error
  summary_json    TEXT,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_recent ON job_runs (job, started_at_ms DESC);

-- One row per job that must not run twice at once (the scan and the live
-- monitor both move simulations; the worker and the "Refresh now" button can
-- start them from different processes). A row past `expires_at_ms` belongs to
-- a process that died and may be taken over.
CREATE TABLE IF NOT EXISTS job_locks (
  name            TEXT PRIMARY KEY,
  holder          TEXT NOT NULL,
  acquired_at_ms  BIGINT NOT NULL,
  expires_at_ms   BIGINT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Positions (holdings the user actually bought at a real venue)
--
-- This is the bridge between advice and reality. The app places no orders; the
-- user buys on Indodax / Pluang / Stockbit and records the fill here. Exit
-- signals are then evaluated against the user's OWN entry price, stop and
-- targets - not against the theoretical entry of the signal that inspired it,
-- which is almost always a different number.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS positions (
  id                TEXT PRIMARY KEY,
  asset_id          TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  -- Where the trade actually happened. Metadata only: the price source is
  -- determined by the asset's exchange, never by this field.
  venue             TEXT NOT NULL,              -- indodax|pluang|stockbit|other
  side              TEXT NOT NULL DEFAULT 'long',

  quantity          DOUBLE PRECISION NOT NULL,
  entry_price       DOUBLE PRECISION NOT NULL,  -- the price the USER actually paid
  entry_at_ms       BIGINT NOT NULL,            -- when the USER bought
  entry_fee         DOUBLE PRECISION,           -- actual fee paid, if known

  -- The plan being followed. Copied from the signal at open time so that later
  -- strategy changes cannot silently rewrite the plan a position was opened on.
  stop_loss         DOUBLE PRECISION,
  take_profit_1     DOUBLE PRECISION,
  take_profit_2     DOUBLE PRECISION,
  timeframe         TEXT NOT NULL,
  trading_style     TEXT NOT NULL,
  strategy_id       TEXT,
  strategy_version  TEXT,
  opened_from_signal_id TEXT REFERENCES trading_signals(id) ON DELETE SET NULL,

  status            TEXT NOT NULL DEFAULT 'open',  -- open | closed
  exit_price        DOUBLE PRECISION,
  exit_at_ms        BIGINT,
  exit_fee          DOUBLE PRECISION,
  exit_reason       TEXT,
  realized_pnl      DOUBLE PRECISION,           -- in the asset's quote currency, net of recorded fees
  realized_pnl_pct  DOUBLE PRECISION,

  notes             TEXT,
  created_at_ms     BIGINT NOT NULL,
  updated_at_ms     BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_positions_open ON positions (status, asset_id);
CREATE INDEX IF NOT EXISTS idx_positions_recent ON positions (entry_at_ms DESC);

-- ---------------------------------------------------------------------------
-- Schema migrations
--
-- One row per applied step from src/lib/db/migrations.ts: changes that
-- CREATE ... IF NOT EXISTS cannot express (a new column on an existing table,
-- a one-off data correction). Each step runs once per database.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migrations (
  id              TEXT PRIMARY KEY,
  applied_at_ms   BIGINT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Indodax trading plans
--
-- scan_runs: one row per scan of the Indodax universe, with the decision the
-- home screen shows (BUY_NOW / WAIT_FOR_ENTRY / NO_TRADE / DATA_UNAVAILABLE /
-- DAILY_STOP / POSITIONS_FULL) and a per-pair summary of why.
--
-- trade_setups: one row per strategy x pair x entry timeframe x signal bar.
-- `plan_json` is the complete deterministic plan (levels, costs, sizing,
-- holding period); `state` is what it means against the live order book and
-- is re-evaluated on every scan. Pages read these rows; they never call the
-- exchange themselves.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scan_runs (
  id                TEXT PRIMARY KEY,
  started_at_ms     BIGINT NOT NULL,
  finished_at_ms    BIGINT,
  engine_version    TEXT NOT NULL,
  status            TEXT NOT NULL,               -- running | ok | partial | error
  decision          TEXT NOT NULL,
  top_setup_id      TEXT,
  universe_size     INTEGER NOT NULL DEFAULT 0,
  pairs_with_data   INTEGER NOT NULL DEFAULT 0,
  summary_json      TEXT NOT NULL,
  error             TEXT
);

CREATE INDEX IF NOT EXISTS idx_scan_runs_recent ON scan_runs (started_at_ms);

CREATE TABLE IF NOT EXISTS trade_setups (
  id                  TEXT PRIMARY KEY,
  setup_key           TEXT NOT NULL UNIQUE,
  asset_id            TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  strategy_id         TEXT NOT NULL,
  strategy_version    TEXT NOT NULL,
  engine_version      TEXT NOT NULL,
  timeframe           TEXT NOT NULL,
  context_timeframe   TEXT NOT NULL,
  kind                TEXT NOT NULL,             -- triggered | pending
  state               TEXT NOT NULL,
  state_reason        TEXT NOT NULL,
  candle_open_ms      BIGINT NOT NULL,           -- the bar that produced the setup
  trigger_price       DOUBLE PRECISION,
  entry_planned       DOUBLE PRECISION NOT NULL,
  entry_max           DOUBLE PRECISION NOT NULL,
  stop_loss           DOUBLE PRECISION NOT NULL,
  take_profit_1       DOUBLE PRECISION NOT NULL,
  take_profit_2       DOUBLE PRECISION,
  score               DOUBLE PRECISION NOT NULL DEFAULT 0,
  validation          TEXT NOT NULL DEFAULT 'experimental',
  plan_json           TEXT NOT NULL,
  score_json          TEXT,
  signal_id           TEXT REFERENCES trading_signals(id) ON DELETE SET NULL,
  analysis_run_id     TEXT REFERENCES analysis_runs(id) ON DELETE SET NULL,
  last_scan_id        TEXT,
  expires_at_ms       BIGINT NOT NULL,
  created_at_ms       BIGINT NOT NULL,
  updated_at_ms       BIGINT NOT NULL,
  state_changed_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_setups_state ON trade_setups (state, updated_at_ms);
CREATE INDEX IF NOT EXISTS idx_setups_asset ON trade_setups (asset_id, timeframe);

-- ---------------------------------------------------------------------------
-- Paper trading (simulation)
--
-- Kept apart from `positions` (real holdings) on purpose: simulated results
-- must never mix with what was actually bought. `plan_json` freezes the plan
-- as it was when the simulation started, so the journal can compare plan with
-- outcome; `fills_json` records every fill with its price source (live ticker
-- or a candle replayed after the monitor was offline) and assumptions.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sim_trades (
  id                TEXT PRIMARY KEY,
  mode              TEXT NOT NULL,               -- auto | manual
  setup_id          TEXT REFERENCES trade_setups(id) ON DELETE SET NULL,
  asset_id          TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  symbol            TEXT NOT NULL,
  strategy_id       TEXT NOT NULL,
  strategy_version  TEXT NOT NULL,
  timeframe         TEXT NOT NULL,
  entry_kind        TEXT NOT NULL,               -- market | limit | trigger
  status            TEXT NOT NULL,               -- pending_entry | open | closed | cancelled
  trigger_price     DOUBLE PRECISION,
  entry_max         DOUBLE PRECISION NOT NULL,
  stop_loss         DOUBLE PRECISION NOT NULL,
  take_profit_1     DOUBLE PRECISION NOT NULL,
  take_profit_2     DOUBLE PRECISION,
  horizon_ms        BIGINT NOT NULL,
  expires_at_ms     BIGINT NOT NULL,             -- a pending entry must fill before this
  initial_quantity  DOUBLE PRECISION,
  quantity          DOUBLE PRECISION,            -- still open
  entry_price       DOUBLE PRECISION,
  entry_at_ms       BIGINT,
  sell_by_ms        BIGINT,
  realized_pnl_idr  DOUBLE PRECISION NOT NULL DEFAULT 0,
  exit_price        DOUBLE PRECISION,            -- final (or average) exit price
  exit_at_ms        BIGINT,
  exit_reason       TEXT,                        -- stop | tp1 | time | manual | expired | cancelled
  mark_price        DOUBLE PRECISION,            -- last bid seen by the monitor
  mark_at_ms        BIGINT,
  last_checked_ms   BIGINT,
  plan_json         TEXT NOT NULL,
  costs_json        TEXT NOT NULL,
  fills_json        TEXT NOT NULL,
  created_at_ms     BIGINT NOT NULL,
  updated_at_ms     BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sim_status ON sim_trades (status, updated_at_ms);
CREATE INDEX IF NOT EXISTS idx_sim_setup ON sim_trades (setup_id);

-- ---------------------------------------------------------------------------
-- Strategy validation
--
-- One row per validation run per strategy x entry timeframe: the plan-level
-- backtest on Indodax history, split chronologically into in-sample and
-- out-of-sample periods, compared with random entries and buy-and-hold. The
-- newest row's `label` decides whether setups are shown as validated or as
-- experimental.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS strategy_validations (
  id                        TEXT PRIMARY KEY,
  strategy_id               TEXT NOT NULL,
  strategy_version          TEXT NOT NULL,
  engine_version            TEXT NOT NULL,
  timeframe                 TEXT NOT NULL,
  computed_at_ms            BIGINT NOT NULL,
  period_from_ms            BIGINT,
  split_at_ms               BIGINT,
  period_to_ms              BIGINT,
  pairs                     INTEGER NOT NULL,
  signals                   INTEGER NOT NULL,
  rejected_json             TEXT NOT NULL,
  in_sample_json            TEXT NOT NULL,
  out_of_sample_json        TEXT NOT NULL,
  random_expectancy_pct     DOUBLE PRECISION,
  random_trades             INTEGER NOT NULL DEFAULT 0,
  buy_hold_pct              DOUBLE PRECISION,
  label                     TEXT NOT NULL,
  unmet_json                TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_validations_latest ON strategy_validations (strategy_id, timeframe, computed_at_ms);
