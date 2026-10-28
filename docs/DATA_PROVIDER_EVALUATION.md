> **Historical document.** Written for the earlier multi-market version (US/IDX stocks, Binance, watchlists) before the app was scoped to Indodax on 2026-10-29. Where it disagrees with the README, the README describes the current app.

# Data provider evaluation

All results below come from **real requests made from the development machine
on 2026-10-22**, reproducible with `npm run providers:verify`. Quotas and
pricing are *as published at the time of writing* and change without notice —
re-check before relying on them.

A provider marked **unverified** has an implemented adapter that has **not**
been confirmed against the live API here. That distinction is carried through
the code (`ProviderCapabilities.verified`), the Settings page and this document.

---

## 1. Cryptocurrency

### Binance public spot API — **verified, selected as default**

| | |
|---|---|
| Endpoint | `GET https://api.binance.com/api/v3/klines` |
| Key required | No |
| Markets | Binance spot |
| Timeframes | 1m, 5m, 15m, 1h, 4h, 1d, 1w (all used by this app) |
| History | 1000 bars per request |
| Delay | Real time |
| Quota | Weight-based IP limit (6000/min at time of writing); a klines call costs weight 2 |
| Cost | Free |

**Observed:** `BTCUSDT 1h` returned 20 bars in 275 ms with full OHLCV.

**Limitations**
- Access is blocked from some jurisdictions, including the US. `BINANCE_BASE_URL`
  can point at a regional host, which has different symbol coverage.
- Quote currency is a **stablecoin** (USDT), not USD. The app labels this
  honestly rather than printing "$".
- Public endpoint: no SLA, no contractual guarantee for personal use.

### Indodax — **verified, and the right default for an Indonesian user**

| | |
|---|---|
| Endpoints | `/api/ticker/{pair}`, `/tradingview/history_v2`, `/api/pairs` |
| Key required | No |
| Markets | Indodax spot, **IDR-quoted** |
| Timeframes | 1m, 5m, 15m, 1h, 4h, 1d, 1w — **all seven this app uses** |
| Delay | Real time |
| Quota | Not published; poll conservatively |

**Observed 2026-10-23:** `BTCIDR` ticker returned last = 1,470,223,000 IDR.
The OHLC endpoint returned full candles with volume at every timeframe
(1m → 12,961 bars over 10 days; 1w → 3 bars). `/api/pairs` lists 449 pairs.

**Why it is the default for IDR crypto:** if you buy on Indodax, you pay IDR on
the Indodax order book. Judging that fill against a Binance USDT price is a
category error — different venue, different currency, different liquidity. The
registry therefore routes an `INDODAX` asset to this adapter regardless of
`CRYPTO_PROVIDER`, because serving Binance data for an Indodax holding would
show the wrong number.

**Limitations**
- IDR prices include a local premium and spread; they will not match global venues.
- Thin liquidity on small-cap IDR pairs produces wide wicks and spreads.
- The OHLC endpoint is the exchange's TradingView datafeed: public, but not formally documented as a product API.

### Coinbase Advanced Trade public market data — **verified, available as alternative**

| | |
|---|---|
| Endpoint | `GET /api/v3/brokerage/market/products/{id}/candles` |
| Key required | No |
| Timeframes | 1m, 5m, 15m, 1h, 1d — **no 4h** |
| History | 350 candles per request |
| Quota | Public market data; 10 req/s documented |

**Observed:** `BTC-USD 1h` returned 20 bars in 420 ms. Cross-checked against
Binance at the same instant: 81,175.36 (Coinbase USD) vs 81,284.01 (Binance
USDT) — a ~0.13% spread, consistent with genuinely independent real sources.

**Limitations**
- No 4h granularity (Coinbase offers 6h). A 4h request is **refused**, not
  silently served as a different bar size.
- Newest-first ordering; normalised on ingest.

### CoinGecko — **evaluated, not integrated**

Reachable (`/api/v3/ping` → 200) and useful for metadata, but its free OHLC
endpoint has coarse, fixed candle granularity that does not map onto the
timeframes this app trades. Using it would mean approximating bar sizes, so it
was left out rather than misrepresented.

---

## 2. US stocks

### Nasdaq public web API — **verified, selected as default**

| | |
|---|---|
| Endpoints | `/api/quote/{sym}/historical`, `/api/quote/{sym}/chart` |
| Key required | No |
| Markets | US-listed equities (NASDAQ/NYSE/AMEX) |
| Timeframes | 1d (true OHLCV); 5m/15m/1h aggregated from ticks |
| Delay | Typically 15 minutes for non-subscribers |
| Quota | Undocumented |

**Observed:** `AAPL 1d` returned 20 bars in 606 ms with real volume
(35,614,130 on 2026-10-21).

**Limitations — important**
- **Undocumented** backend of nasdaq.com. No API contract; it may block clients
  at any time. Requires browser-like headers.
- **Intraday has no per-bar volume.** The `chart` endpoint returns 1-minute
  *last-price ticks*; the `volumeChart` field was inspected and found to contain
  **prices, not volume**. Intraday bars are therefore aggregated from ticks with
  `volume = null`. Volume-confirmed strategies refuse to run on it.
- Intraday history covers the **current session only** — not enough warm-up for
  most intraday strategies on its own.
- Ticks begin at 04:00 ET (pre-market); the adapter filters to regular hours.
- **No IDX coverage.**

### Alpha Vantage — **verified with the public demo key**

| | |
|---|---|
| Key required | Yes (free) |
| Markets | US equities |
| Timeframes | 1m, 5m, 15m, 1h, 1d |
| Quota | **25 requests/day** on the free tier at time of writing |
| Cost | Free tier; paid plans for more |

**Observed:** `TIME_SERIES_DAILY` and `TIME_SERIES_INTRADAY` for `IBM` both
returned real data with the documented `demo` key (which serves IBM only).

**Limitations**
- 25 requests/day is severe: roughly a handful of assets refreshed a few times
  daily. Unusable for scalping or day trading.
- Quota exhaustion is returned as **HTTP 200** with a JSON `Information`/`Note`
  field. The adapter detects this and raises a rate-limit error instead of
  parsing it as data.
- Intraday timestamps are US/Eastern; converted to UTC with DST resolved per
  instant.
- No IDX on the free tier.

---

## 3. Indonesian stocks (IDX / BEI) — **no verified free source**

This is the most important honest finding in the project.

| Candidate | Result |
|---|---|
| **IDX official** (`idx.co.id/primary/...`) | **HTTP 403.** Incapsula bot protection. Not usable programmatically. |
| **Yahoo Finance `.JK`** | **One** successful response for `BBCA.JK` (IDR, exchange "JKT"), then **persistent HTTP 429** — including after the documented `fc.yahoo.com` cookie + `getcrumb` warm-up. Retested on 2026-10-23 against both `query1` and `query2`: still 429. The limit is **per IP**, so this very likely reflects this machine's shared egress address rather than a universal block — it may work from your network. Test it without enabling it: `npm run providers:verify -- --probe yahoo`. Unverified. |
| **Twelve Data** | `GET /stocks?country=Indonesia&symbol=BBCA` returned a real IDX entry (`exchange: IDX`, `mic_code: XIDX`, `currency: IDR`) **without a key**. But `time_series` rejects the demo key, so **free-plan IDX candle access is unconfirmed**. |
| **Stooq** | JavaScript challenge page instead of CSV. Not usable (retested with full browser headers 2026-10-23 — still challenged). |
| **TradingView public scanner** (`scanner.tradingview.com/indonesia/scan`) | **Returns real IDX data**, verified 2026-10-23: `IDX:BBCA` open 5125 / high 5275 / low 5100 / close 5175 IDR, volume 286,928,500, and `update_mode: "delayed_streaming_600"` (10-minute delay, self-declared). **But it is a screener, not a history API** — it returns only the current day's bar plus performance aggregates, with **no candle series**. Indicators need 120+ bars of warm-up, so this cannot drive signals. It is also an undocumented internal endpoint, and automated use is likely contrary to TradingView's terms. **Not integrated** pending an explicit decision. |

### What the app does about it

- The seeded watchlist includes `BBCA` on exchange `IDX`.
- With the default configuration, it displays **NO DATA** plus the exact reason:
  *"No configured provider can supply 1d data for IDX | nasdaq: does not cover
  IDX | alphavantage: does not cover IDX."*
- It **never** substitutes US data, and never relabels delayed data as real-time
  Indonesian data.
- Two opt-in paths exist, both clearly marked unverified:
  - `ENABLE_YAHOO_PROVIDER=true` — unofficial, undocumented, aggressively rate
    limited. Review Yahoo's terms before using it. **Test it first without
    enabling it:** `npm run providers:verify -- --probe yahoo`. Because the
    rate limit is per IP, this is the single most likely path to working IDX
    candles from your own machine.
  - `TWELVEDATA_API_KEY=...` — then run `npm run providers:verify` to discover
    whether *your* plan actually returns IDX candles.

### Symbol conventions

The app stores one canonical symbol (`BBCA`, exchange `IDX`) and translates per
provider: `BBCA.JK` for Yahoo, `BBCA:IDX` for Twelve Data. Business logic never
learns a vendor's naming scheme.

---

## 4. News

| Source | Status | Notes |
|---|---|---|
| **Federal Reserve** `feeds/press_monetary.xml` | **Verified** | Primary source for FOMC statements and rate decisions. No key. |
| **CoinDesk** `arc/outboundfeeds/rss/` | **Verified** | Requires following a 308 redirect. No key. |
| **SEC EDGAR** Atom (8-K) | **Verified with a contact User-Agent** | Returns **403** without one. The feed is *skipped with an explicit reason* unless `SEC_USER_AGENT` is set — the app never sends anonymous requests to the SEC. |
| Additional feeds | Supported | `NEWS_EXTRA_FEEDS="id\|name\|url;..."`, validated as http(s). |

**Observed:** 35 articles fetched across two feeds; 32 stored, **3 collapsed by
deduplication**; 9 asset links created by explicit ticker/alias matching.

Commercial-use note: these are public RSS feeds intended for syndication. This
app stores headline, URL, publisher, timestamps and a short excerpt for personal
research, and links to the original. Check each publisher's terms before any
redistribution.

---

## 5. AI providers — **implemented, unverified here**

| Provider | Endpoint | Status |
|---|---|---|
| Anthropic | `POST /v1/messages` | Adapter implemented; **no live call made** (no key configured) |
| OpenAI | `POST /v1/chat/completions` with `response_format: json_object` | Same |
| OpenRouter | `POST /api/v1/chat/completions` | Same |
| Ollama | `POST /api/chat`, `format: json` | Same — **local, zero marginal cost, no data leaves the machine** |
| Google Gemini | OpenAI-compatible `POST /v1beta/openai/chat/completions`, `json_object` | **Verified 2026-10-28** — free tier, no card. Key valid; `gemini-3.5-flash` answered a short request, but every Flash model (3.8, 3.7, 3.5) returned HTTP 503 "high demand" for full analyses that day, one after 76 s. Free-tier prompts may be used by Google to improve its products |
| Groq | OpenAI-compatible `POST /openai/v1/chat/completions`, strict `json_schema` | **Verified 2026-10-28** — free tier, no card. ~0.5–1 s per call. Free plan limits `qwen3.8-27b` to **1,000 output tokens per minute** and refuses any request expected to exceed it (`OTPM: Limit 1000, Requested 1398`), so output is capped at 1,000 tokens and the prompt asks for a concise answer |

`AI_PROVIDER` is an ordered fallback chain (`gemini,groq,ollama`), and each
`*_MODEL` may list several models (`GEMINI_MODEL=gemini-3.8-flash,gemini-3.5-flash`),
because free tiers overload and run out per model. A model that errors, hits
its quota, returns malformed JSON or fails validation hands over to the next;
the analysis notes which model answered and why earlier ones did not.

A model that reports overload or a rate limit is skipped for a while so it
does not add its timeout to every analysis: 90 s after a 429 (per-minute
budgets), 5 min after a 503 (overload), 10 min after a timeout, or longer if
the provider sends `Retry-After`. If every model is cooling down, all are
tried anyway.

Why Gemini first: on Vals AI's Finance Agent v2 leaderboard (20 Oct 2026),
`gemini-3.8-flash` scored 61.4%, second of 81 models and ahead of every paid
Claude and GPT model listed, while being free. That benchmark measures
analyst work on company filings, not price prediction.

Set a key and run `npm run providers:verify`; it makes one tiny real call and
reports the result. Until then the platform runs fully on deterministic analysis
and labels AI commentary as unavailable.

**Cost controls in code:** `AI_PROVIDER=none` by default; a cache window
(`AI_CACHE_MINUTES`, default 180); a hard daily ceiling
(`AI_MAX_CALLS_PER_DAY`, default 50); AI is withheld entirely when data quality
is not `ok`; and **page rendering never triggers a call** — only the explicit
"Generate AI analysis" action and the scheduled job pass `allowAiCall: true`.

---

## 6. Notifications

| Channel | Status |
|---|---|
| In-app | **Working** — always available, stored in `alerts` + `notification_deliveries` |
| Telegram Bot API | **Implemented, unverified** — free; needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. `telegramSelfTest()` calls `getMe` without sending a message. |

---

## 7. Cost summary

| Item | Cost |
|---|---|
| Binance / Coinbase / Nasdaq / RSS feeds | **$0**, no key |
| Alpha Vantage, Twelve Data | **$0** on free tiers, key required |
| Database | **$0** — SQLite file locally; any Postgres for deployment |
| AI | **$0** with Gemini / Groq free tiers, Ollama, or `AI_PROVIDER=none`; otherwise per-token, capped |
| Telegram | **$0** |
| Hosting | **$0** on a free tier, with the scheduling caveats in DEPLOYMENT.md |

**No paid service is a mandatory dependency.** No credit card is needed to run
the full MVP locally with real market data.
