# Deployment

## Local (recommended for this app)

```bash
cp .env.example .env.local
npm install
npm run db:migrate
npm run db:seed
npm run refresh
npm run dev          # terminal 1
npm run worker       # terminal 2 — continuous refresh/news/evaluation
```

Requires **Node 22+** (uses the built-in `node:sqlite`; developed on Node 26).
No database server, no Docker.

With `AUTH_PASSWORD` unset, the app accepts **localhost connections only** — a
remote request gets HTTP 403 with an explanation.

---

## The scheduling problem — read this before choosing a host

This app's value comes from *continuous* monitoring. Most free serverless tiers
**cannot do that**:

* Functions run only while handling a request; nothing runs in between.
* Platform cron on free tiers is typically coarse (often once per day) and is
  not guaranteed.
* Function timeouts (10–60 s) can truncate a refresh across many assets.
* Ephemeral filesystems mean a SQLite file does not persist.

**So the app does not claim continuous monitoring it cannot deliver.** The
Alerts page says so, and every page shows when data was actually retrieved.

| Option | Scheduling reality | Database | Cost |
|---|---|---|---|
| **Local + `npm run worker`** | Genuine, as frequent as you configure | SQLite file | $0 |
| **Small VPS / home server** | Genuine (systemd or pm2) | SQLite or Postgres | ~$0–5/mo |
| **Serverless + external scheduler** | Only as often as the scheduler fires | Managed Postgres required | $0 if both tiers are free |
| **Serverless alone, free tier** | Effectively none | — | Not recommended |

---

## Option A — VPS or always-on machine

```bash
npm ci && npm run build
npm run db:migrate && npm run db:seed
```

Two systemd units — the web app and the worker:

```ini
# /etc/systemd/system/ai-trade.service
[Unit]
Description=AI Trade web
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ai-trade
EnvironmentFile=/opt/ai-trade/.env.local
ExecStart=/usr/bin/npm start
Restart=always
User=aitrade

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/ai-trade-worker.service
[Unit]
Description=AI Trade worker
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ai-trade
EnvironmentFile=/opt/ai-trade/.env.local
ExecStart=/usr/bin/npm run worker
Restart=always
RestartSec=30
User=aitrade

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now ai-trade ai-trade-worker
```

Put a TLS-terminating reverse proxy in front (Caddy gives automatic HTTPS in two
lines). Set `AUTH_PASSWORD` and `AUTH_SESSION_SECRET` **before** exposing it.

Ensure `EnvironmentFile` is `chmod 600` and owned by the service user.

---

## Option B — Serverless (Vercel/Netlify) + managed Postgres + external scheduler

1. **Database:** create a PostgreSQL instance (Supabase, Neon and similar offer
   free tiers) and set `DATABASE_URL`. The same `schema.sql` applies unchanged.
   Run `npm run db:migrate` once from your machine against that URL.
2. **Deploy** the app. Set every variable from `.env.example` in the host's
   environment settings — never commit them.
3. **Set `CRON_SECRET`** to a strong random value.
4. **Schedule** an external caller (a cron-as-a-service, a GitHub Actions
   schedule, or any always-on box) to POST:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-app/api/cron/refresh
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-app/api/cron/news
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-app/api/cron/evaluate
```

Suggested cadence: refresh every 15–30 min, news every 30–60 min, evaluate
hourly. Stay well inside your providers' quotas — with Alpha Vantage's 25
requests/day, a 15-minute refresh of even one US stock exhausts the quota before
lunch. Prefer Nasdaq (no key) for US equities, or lengthen the interval.

GitHub Actions is a reasonable free scheduler; note that scheduled workflows can
be delayed under load and are disabled on inactive repositories.

5. **Verify** `maxDuration` on the cron routes (set to 60 s here) fits your
   plan's function limit, and keep the watchlist small enough to finish inside
   it.

---

## Database migration between dialects

The schema is portable, but the **data** is not copied automatically. To move
from local SQLite to Postgres, migrate the schema with `npm run db:migrate`
against the new `DATABASE_URL`, then export/import the tables you care about —
in practice only `trading_signals` and `signal_evaluations` are irreplaceable;
candles and news re-fetch themselves.

---

## Post-deployment checks

```bash
curl -s https://your-app/api/health                 # {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" https://your-app/   # 307 → /login
npm run providers:verify                            # from a machine with the same env
```

Then open the app, sign in, and confirm the Settings page shows the expected
providers as "configured" and recent jobs as `ok`.

---

## Operational notes

* **Back up** the SQLite file (or Postgres) before upgrades. Signals and
  evaluations are the only irreplaceable history.
* **Watch `provider_status`** on the Settings page. Rising
  `consecutive_failures` usually means a rate limit or a provider change.
* **Watch `job_runs`.** A `partial` status lists exactly which assets failed.
* **Logs contain no secrets** by design; provider errors carry response bodies
  only.
