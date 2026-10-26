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
-- Watchlists
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS watchlists (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  is_default      INTEGER NOT NULL DEFAULT 0,
  created_at_ms   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist_assets (
  watchlist_id    TEXT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  asset_id        TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  trading_style   TEXT NOT NULL DEFAULT 'swing',  -- scalping|day|swing|position
  added_at_ms     BIGINT NOT NULL,
  notes           TEXT,
  PRIMARY KEY (watchlist_id, asset_id)
);

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

CREATE TABLE IF NOT EXISTS price_thresholds (
  id              TEXT PRIMARY KEY,
  asset_id        TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL,               -- above|below
  price           DOUBLE PRECISION NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at_ms   BIGINT NOT NULL,
  triggered_at_ms BIGINT,
  UNIQUE (asset_id, direction, price)
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
-- Instrument catalogue
--
-- A cached list of everything the configured providers can actually serve, so
-- the user can browse and choose instead of being limited to a seeded
-- watchlist. Refreshed on demand - it is reference data, not market data, and
-- re-fetching thousands of rows on every page view would be wasteful.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instrument_catalog (
  exchange_id     TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  asset_class     TEXT NOT NULL,
  currency        TEXT NOT NULL,
  provider        TEXT NOT NULL,
  -- Nullable on purpose: most providers do not supply these, and a missing
  -- value must stay missing rather than be guessed at.
  last_price      DOUBLE PRECISION,
  market_cap      DOUBLE PRECISION,
  change_pct      DOUBLE PRECISION,
  volume          DOUBLE PRECISION,
  tick_size       DOUBLE PRECISION,
  lot_size        DOUBLE PRECISION,
  min_notional    DOUBLE PRECISION,
  fetched_at_ms   BIGINT NOT NULL,
  PRIMARY KEY (exchange_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_catalog_class ON instrument_catalog (asset_class, exchange_id);
CREATE INDEX IF NOT EXISTS idx_catalog_cap ON instrument_catalog (market_cap);
