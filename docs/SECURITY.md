> **Historical document.** Written for the earlier multi-market version (US/IDX stocks, Binance, watchlists) before the app was scoped to Indodax on 2026-10-29. Where it disagrees with the README, the README describes the current app.

# Security

Security is treated as a release requirement, not a later hardening pass.

---

## 1. Secrets

**Rules enforced in code**

* Every secret is read from `process.env` on the **server only**, through
  `src/lib/config/env.ts`, which imports `server-only`. A client import is a
  build error, not a runtime leak.
* **There is no `NEXT_PUBLIC_` variable in this project.** Verify with
  `grep -rn "process.env.NEXT_PUBLIC" src/` — no matches. (Plain `NEXT_PUBLIC`
  appears only in a comment and in on-screen text explaining this rule.)
* API keys are **never** written to the database. `application_settings` is for
  non-secret preferences only, and the schema says so in a comment.
* API routes return booleans about configuration (`aiEnabled`,
  `telegramEnabled`), never values. The Settings page shows "configured" /
  "API key missing" and never the key.
* `.env`, `.env.local`, `.env.*.local`, `*.pem`, `*.key` and `secrets/` are in
  `.gitignore`. `.env.example` contains **placeholders only**.
* Error messages from providers carry response bodies, never request headers, so
  a bot token cannot reach a log through an exception.

**Verification**

```bash
grep -rn "process.env.NEXT_PUBLIC" src/          # expect no matches
npm run build
grep -rlE "ANTHROPIC_API_KEY|GEMINI_API_KEY|GROQ_API_KEY|AUTH_PASSWORD|TELEGRAM_BOT_TOKEN" .next/static/   # expect nothing
git check-ignore -v .env.local                   # expect a match
```

---

## 2. Authentication

Single-user password gate (`src/lib/auth/session.ts`, `src/proxy.ts`).

* `AUTH_PASSWORD` + `AUTH_SESSION_SECRET` → HMAC-SHA256-signed, HttpOnly,
  SameSite=Lax, Secure-in-production cookie. The cookie contains an expiry and a
  signature — never the password.
* **If `AUTH_PASSWORD` is empty the app refuses all non-localhost requests**
  (HTTP 403 with an explanation). A private URL is explicitly *not* treated as
  access control.
* Password comparison is constant-time.
* Login is throttled: 8 attempts per IP per 5 minutes, then HTTP 429.
* Failures return "Incorrect password" with no hint about closeness.
* Every page and API route is protected except `/login`, `/api/auth/login` and
  `/api/health` (which exposes only `{status}` — no configuration, no counts).
* `/api/cron/*` uses a **bearer token** (`CRON_SECRET`) compared in constant
  time, because a scheduler has no cookie. With `CRON_SECRET` unset these routes
  accept localhost only.

**Before exposing this publicly, you must set `AUTH_PASSWORD` and
`AUTH_SESSION_SECRET`.** Generate them with:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

---

## 3. Input validation

* Every API request body and query string is parsed with a **Zod** schema;
  anything that fails is rejected with 400 before touching a service.
* Symbols are constrained to `^[A-Za-z0-9._:-]+$`; ids must be UUIDs;
  timeframes and actions are enums.
* All database access is through **parameterised** queries. No string
  interpolation of user input into SQL anywhere.
* The login redirect only accepts same-origin paths, so a crafted `?next=` can
  not bounce the user to another site.

---

## 4. Outbound requests (SSRF)

One guarded client (`src/lib/providers/http.ts`) handles every outbound call:

* **Scheme allow-list:** http/https only — `file:`, `data:`, `javascript:`
  rejected.
* **Private-network block:** `localhost`, `127.0.0.0/8`, `10/8`,
  `192.168/16`, `172.16–31/12`, `169.254/16` (cloud metadata), `[::1]`,
  `*.internal`. Tested in `tests/providers.test.ts`.
* **Response size cap** (8 MB default) checked on both `content-length` and the
  materialised body.
* **Timeouts** on every request; bounded retries with exponential backoff and
  full jitter, honouring `Retry-After`.
* The only exception is Ollama on localhost, which requires an explicit
  `x-allow-local` header set by that adapter alone — never by a URL discovered
  in external content.

URLs extracted from RSS feeds pass through `sanitizeUrl()` and are dropped if
they are not http(s).

---

## 5. Prompt injection

External article text is **untrusted input** that eventually reaches an LLM.
Defence in depth:

1. **Scan the raw payload** for instruction-like patterns *before* HTML
   stripping — markup attacks such as `<system>…</system>` would otherwise be
   silently removed and never flagged.
2. **Strip markup** and decode entities.
3. **Scan and neutralise again** on the cleaned text; matches are replaced with
   `[removed: instruction-like text]` and recorded as flags.
4. **Remove zero-width and bidirectional control characters** used to hide
   instructions from a human reader while leaving them visible to a model.
5. **Fence** the remaining text in `<untrusted_article_content>` with a system
   instruction that content inside is data, never instructions, and that any
   apparent instruction must be reported under "limitations" and ignored.
6. **Validate the output.** The response schema has **no numeric fields**, so a
   model cannot emit a price or probability. Citations are checked against the
   exact URL list supplied in the prompt — an invented source causes the whole
   response to be **discarded**. Phrases promising guaranteed profit, risk-free
   returns or numeric success probabilities are rejected.

The ultimate protection is structural: **AI output can never change an action, a
price, an indicator value, or a risk number.** Those come from deterministic
code before the model is called.

Covered by 13 tests in `tests/security.test.ts`.

---

## 6. Output and rendering

* React escapes interpolated content by default; the app uses **no**
  `dangerouslySetInnerHTML`. Verify: `grep -r "dangerouslySetInnerHTML" src/`.
* External links carry `rel="noopener noreferrer nofollow"` and `target="_blank"`.
* Security headers are set in `next.config.mjs`: `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  and a `Permissions-Policy` disabling camera, microphone and geolocation.
* `robots: noindex, nofollow` on the app shell.

---

## 7. Financial safety

* **No order execution. No brokerage credentials. No payment integration.**
  There is no code path that can place a trade or move money.
* Position sizes are configurable examples derived from `RISK_*` environment
  variables, labelled as such, and are refused outright when inputs are invalid
  or exchange increments are unknown.
* The app never claims guaranteed profit; the AI validator actively rejects such
  phrasing.

---

## 8. Dependency posture

**`npm audit`: 0 vulnerabilities** (2026-10-27, after the upgrade below).
Every previously "accepted" finding has now been fixed rather than accepted.

| Finding | Severity | Resolution |
|---|---|---|
| `tinypool` prototype pollution → RCE (via `vitest`) | critical | `vitest@5.0.5` |
| `vitest` / `@vitest/mocker` path traversal, code injection | critical / moderate | `vitest@5.0.5` |
| `zod` memory exhaustion validating oversized constrained collections | high | `zod@4.6.7` |
| `postcss` vendored inside `next` — path traversal via sourceMappingURL | high | `next@16.4.3` |
| `sharp` / libvips, libheif, librsvg | high | `sharp@0.35.5` (semver-compatible) |
| `next` RCE (GHSA-9qr9-h5gf-34mp, CVSS 10) | critical | fixed earlier (`15.5.28`), superseded by 16.4.3 |

**Why zod was the most important of these:** the other findings live in build
or test tooling that never ships. Zod runs on every API request, and the
vulnerable pattern — `z.array(...).max(n)` — is applied to **untrusted model
output** in `lib/analysis/schema.ts`. That was a real exposure path.

See `docs/DEPENDENCY_UPGRADE.md` for the step-by-step record, including what
each major version broke and how it was fixed.

Review with `npm audit --omit=dev` and re-run after every install.

---

## 9. Secret rotation

1. Generate the new value (see the command in §2).
2. Update `.env.local` (or your host's environment settings).
3. Restart the app and the worker — `env()` memoises per process.
4. Revoke the old credential **at the provider** (Alpha Vantage, Twelve Data,
   Anthropic, OpenAI, OpenRouter, BotFather for Telegram).
5. Run `npm run providers:verify` to confirm the new credential works.

Rotating `AUTH_SESSION_SECRET` invalidates every existing session immediately —
that is the fastest way to log out an attacker.

Rotate immediately if: a key appeared in a shell history, a log, a screenshot or
a commit; a device with `.env.local` was lost; or an unexplained spike appears
in a provider's usage dashboard.

---

## 10. Incident response

1. **Contain.** Rotate `AUTH_SESSION_SECRET` (kills all sessions). Stop the
   worker. Take the deployment offline if it is public.
2. **Assess.** This app stores market data, public news, generated signals and
   preferences — **no financial accounts and no payment details**. The realistic
   worst case for a leaked provider key is quota abuse and cost on that
   provider's bill.
3. **Rotate** every credential in `.env.example` order, revoking each at source.
4. **Review** `provider_status` (unexplained call counts), `job_runs`
   (unexpected runs) and `notification_deliveries` (messages you did not
   expect).
5. **Recover.** The database holds no irreplaceable state: candles and news can
   be re-fetched; signal history is the only record worth preserving, so back up
   the SQLite file or Postgres database before any destructive step.
6. **Record** what happened and which control failed.

---

## 11. Checklist before deploying publicly

- [ ] `AUTH_PASSWORD` and `AUTH_SESSION_SECRET` set to strong random values
- [ ] `CRON_SECRET` set if any external scheduler calls `/api/cron/*`
- [ ] HTTPS enforced by the host
- [ ] `.env*` files confirmed untracked (`git status --porcelain`)
- [ ] `npm audit --omit=dev` reviewed
- [ ] `npm run build` succeeds and no secret appears in `.next/static`
- [ ] `npm test` passes
- [ ] A real browser check that `/` redirects to `/login` when signed out
