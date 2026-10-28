> **Historical document.** Written for the earlier multi-market version (US/IDX stocks, Binance, watchlists) before the app was scoped to Indodax on 2026-10-29. Where it disagrees with the README, the README describes the current app.

# Dependency upgrade — 2026-10-27

**Result: `npm audit` 7 findings (2 critical, 3 high, 2 moderate) → 0.**

Done one package at a time, in rising order of risk. After each step the same
gate had to pass in full before moving on: `tsc --noEmit`, `eslint`, the whole
test suite, `next build`, and every route returning 200 from a real
production server. No test was skipped, loosened or deleted to get there.

| Step | Package | From → To | Findings after |
|---|---|---|---|
| 1 | `sharp` (via `next`) | 0.34.5 → 0.35.5 | 7 → 6 |
| 2 | `vitest` | 3.2.7 → **5.0.5** (major) | 6 → 3 — both criticals gone |
| 3 | `zod` | 3.25.76 → **4.6.7** (major) | 3 → 2 |
| 4 | `next` + `eslint-config-next` | 15.5.28 → **16.4.3** (major) | 2 → **0** |

---

## What each major version broke

### Vitest 5 — JSX in tests stopped compiling

Two tests import `price-chart.tsx` and failed with *"Failed to parse source
for import analysis"*. Vitest 5 runs on Vite 8, whose Oxc transformer honours
`tsconfig.json`'s `"jsx": "preserve"`; Vitest 3 transformed JSX regardless.
`preserve` has to stay — Next does its own JSX transform — so the fix is
`oxc.jsx` in `vitest.config.ts`, scoped to the test runner.

### Zod 4 — nothing broke, but it was checked, not assumed

Audited every v4-sensitive pattern before installing:

- `.errors` — 11 hits, **none** were `ZodError.errors` (removed in v4); all are
  the app's own result objects.
- `.uuid()` — v4 enforces RFC 9562 variant bits. Every ID in the database was
  checked (0 non-compliant) and `crypto.randomUUID()` passed 10,000 of 10,000.
- `.format(` was `Intl`, not zod. No `message:`/`errorMap`/`.flatten()` usage.

Then the validation boundary was probed against a running server: eight
malformed requests (wrong enum case, non-UUID, negative price, non-JSON body,
script characters, non-numeric and out-of-range query params, invalid
direction) all returned **400** with readable messages; valid input was still
accepted. Messages are worded differently in v4 (`Invalid option: expected
one of …`) — no test depended on the old wording.

### Next 16 — four things

1. **ESLint crashed before linting anything** (*"Converting circular structure
   to JSON"*). `eslint-config-next` 16 ships native flat configs; the old
   `FlatCompat` shim tried to load them as eslintrc. Now spread directly.
2. **The new React Compiler lint rules found a real bug in our code**:
   `useEffect(() => setMoreOpen(false), [pathname])` in the nav caused an extra
   render on every navigation. Rewritten as React's documented "adjust state
   when a prop changes" pattern. The rule was not disabled.
3. **`middleware` → `proxy`.** Renamed the file and function, per the official
   migration guide. Proxy runs on the **Node.js** runtime (setting `runtime`
   in its config now throws); comments and docs that said "Edge" were
   corrected.
4. **Turbopack, now the default bundler, traced the entire project** into the
   server output because of a dynamic `process.cwd()` path in the database
   driver. Scoped with `turbopackIgnore` — the database file must never be
   bundled anyway.

---

## The auth gate was tested, not inferred

The proxy file is the authentication gate, and a misnamed proxy fails
**silently** — Next simply never runs it and every route becomes public. The
route check alone could not catch that: on localhost with no password the
gate lets everything through by design, so "all routes 200" would pass either
way.

So it was exercised directly, against a production server:

| Scenario | Expected | Got |
|---|---|---|
| No password, remote `Host` header → page / API | 403 | 403 / 403 |
| No password, public `/api/health` | 200 | 200 |
| Password set, no session → page | redirect to login | `307 → /login?next=%2Fportfolio` |
| Password set, no session → API | 401 | 401 |
| Wrong password | 401 | 401 |
| Forged session cookie | 401 | 401 |
| Correct password, then page and API | 200 | 200 / 200 |
| Session cookie | `Secure; HttpOnly; SameSite=lax` | unchanged |

A test now fails if `src/proxy.ts` is missing, `src/middleware.ts` reappears,
the export is not named `proxy`, or a `runtime` key is added.

---

## Found while verifying, not caused by the upgrade

Running the dev server in a real browser — Next 16 switched `next dev` to
Turbopack too, a different pipeline from the build — surfaced two defects in
the chart readout from the earlier UI pass. Both are fixed and pinned by
tests; see `docs/UI_UX_REVIEW.md` §5.

Also observed and **left alone** as out of scope: a request body that is not
JSON produces `": Invalid input: expected object, received null"` — the leading
colon comes from an empty error path. This predates the upgrade.

---

## Rollback

No commits were made. Lockfile snapshots from before each step were kept
outside the repository for the duration of the work.
