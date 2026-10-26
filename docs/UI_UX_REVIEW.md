# UI/UX review and redesign

Pass run with the `ui-ux-pro-max` skill. This records what was **measured**, what
changed, what was deliberately **not** taken from the skill's output, and what
could not be verified.

The design system itself lives in `design-system/ai-trade/MASTER.md`.

---

## 1. How the skill's output was used

The skill is a recommendation engine, not an authority. Two of its outputs were
rejected on evidence:

| Skill output | Verdict | Why |
|---|---|---|
| Page pattern **"Enterprise Gateway"** (hero video, client logos, Contact Sales) | **Rejected** | A marketing landing-page pattern. AI Trade is an authenticated single-user dashboard with no marketing surface. `products.csv` itself lists the matching row, *Financial Dashboard*, as "N/A — Dashboard focused". |
| Accent `#22C55E` + destructive `#EF4444` | **Rejected** | Measured under a deuteranope simulation: that pair separates by ΔE **18.0**; the pair already in `tailwind.config.ts` separates by ΔE **43.5**. Adopting it would have *reduced* colourblind legibility. |
| Fira Code / Fira Sans from the Google Fonts CDN | **Deferred** | The app has no third-party runtime dependency and must build offline. System stack kept; `tnum` gives the tabular figures a dashboard needs. Recorded for later self-hosting via `next/font`. |
| Style: Data-Dense Dashboard + Minimalism/Swiss | **Adopted** | Matches what the app already was. |
| `web-target-size`, `adaptive-navigation`, `font-scale`, candlestick a11y | **Adopted** | See below. |

---

## 2. Measurements taken before changing anything

**Colour contrast** — all 21 foreground/surface pairs, WCAG 2.1:

| | `bg` | `bg-raised` | `bg-inset` |
|---|---|---|---|
| `ink` | 16.01 | 15.00 | 16.43 |
| `ink-muted` | 6.53 | 6.11 | 6.70 |
| `ink-faint` | 5.16 | **4.84** | 5.30 |
| `up` | 6.07 | 5.69 | 6.23 |
| `down` | 4.94 | **4.63** | 5.07 |
| `accent` | 5.81 | 5.44 | 5.96 |
| `warn` | 5.33 | **4.99** | 5.47 |

Every pair passes AA for normal text. **The palette was therefore left alone** —
the problems were elsewhere.

**Type sizes in the source** — `text-2xs` (11px) appeared **230** times out of
297 font-size utilities. 11px was not an accent size; it was the app's default.

---

## 3. What changed

### Typography — the single biggest defect
`2xs` was 11px, below the 12px body floor, and dominant. The **scale was lifted
at the token layer** rather than rewriting 230 call sites:

`12 / 13 / 14 / 16 / 18 / 20 / 24` — matching the skill's `font-scale` guideline.

Verified in the browser: the smallest rendered text anywhere is now **12px**.

### Keyboard focus
The app had **two** `focus-visible` declarations in ~130 files. Added one global
`:focus-visible` ring (accent, 2px, 2px offset) so a control added later cannot
silently opt out. Four form inputs used `outline-none` with only a border tint —
removed. Verified live: `solid 2px rgb(61, 139, 253)`.

### Pointer target size
Applied **WCAG 2.2 AA 2.5.8 — 24×24 CSS px**, *not* the 44pt/48dp figures, which
are native-platform guidance and do not define web conformance (the skill calls
this out explicitly).

- Tooltip marker `HintMark` was **12×12px with an 8px glyph** → 18px visual with
  a `.tap-24` pseudo-element expanding the hit area. Hit-tested in the browser:
  the expanded area registers above and beside the visual box.
- Language/currency toggle segments (23.9px), the guide's "Hide" control
  (16.8px tall), "see all" links (14px tall) and news headlines (15px tall) all
  raised to the floor.
- **One documented exception remains**: the inline "Evaluation" link inside a
  sentence, which 2.5.8 exempts (*"the target is in a sentence"*). Padding it
  would break the line box.

### Navigation
Was: 11 equal-weight links, shown only at `xl` (1280px) — so **every laptop
between 1024 and 1279px had no navigation at all**.

Now, per `adaptive-navigation` and `bottom-nav-limit`:
- Five primary destinations ordered by the real workflow — Overview → Signals →
  Portfolio → Scanner → Products — from `lg` (1024px).
- Six secondary destinations grouped under **More** (Trading / Research /
  Review), dismissible by outside-click and Escape, focus returned to trigger.
- Below `lg`, a bottom bar with the same five, `env(safe-area-inset-bottom)` for
  the home indicator, and `pb-20` on the page so nothing hides behind it.
- The "More" sheet is a real `role="dialog" aria-modal`, with a **visible close
  button** (a tappable scrim is not a visible affordance) and focus moved in on
  open, returned on close.

### Tables
- `scope="col"` on every header — without it a cell in a 13-column scan table
  has no column name.
- Scroll wrapper is focusable, so keyboard users can reach right-hand columns.
- `role="region"` is applied **only when a caption exists** — an unnamed
  landmark is worse than none.
- *Not* made sticky: `overflow-x-auto` makes the wrapper a scroll container with
  no height constraint, so `position: sticky` would resolve against it and do
  nothing. Documented in the component rather than shipped as a dead class.

### Candlestick chart
The chart database grades candlestick as a *conditional* accessibility risk and
requires that bullish/bearish not depend on colour. Added:
- **Hollow up / filled down** candles — survives deuteranopia and greyscale.
- A **crosshair readout** in real DOM (`aria-live="polite"`) — a tooltip inside
  `<canvas>` does not exist for assistive tech.
- A collapsible **OHLC fallback table** (30 rows, scoped headers, caption, and
  direction as "▲ Rising" / "▼ Falling" — word *and* glyph).
- Fixed a latent bug: the series time key and the crosshair lookup key were
  derived by different expressions and would have silently diverged for any feed
  with sub-second precision. Both now use `timeKey()`.

### Reduced motion
`prefers-reduced-motion: reduce` was honoured **nowhere**. Now global.

### Token discipline
Three hardcoded `#3fb950` / `#e5534b` price-line colours — the *superseded*
palette — were bypassing the validated tokens at the chart call site. Replaced.

---

## 4. Regression protection

`tests/ux-contract.test.ts` — **29 tests** asserting these properties of the
source, because they are exactly the rules that regress silently: nothing fails
to compile when someone adds an 11px label or a control with no focus ring.

Includes a guard that no two bottom-bar destinations share an icon (Signals and
Scanner shipped identical glyphs in the first draft of this pass).

---

## 5. Verification status

**Verified by measurement or in the browser:**
- 231 tests pass; typecheck, lint and production build clean.
- All 13 routes return 200 in both `en` and `id`.
- Smallest rendered font size: 12px. Font sizes in use: 12/13/14/16/18.
- Focus ring renders; skip link is the first tabbable element.
- `.tap-24` hit area confirmed by hit-testing, not assumed.
- Sub-24px targets: 1 remaining, documented exception above.
- No page-level horizontal overflow at 375 / 882 / 1400px.
- Mobile bottom bar, "More" sheet, dialog semantics and focus movement.
- Chart fallback table: 30 rows, scoped headers, caption.
- Indonesian renders for every new key.

**Not verified:**
- ~~The live crosshair readout updating on hover.~~ **Verified later** (during
  the Next 16 upgrade, with real pointer input): hovering 01 Aug '26 showed
  `Open 1.13B High 1.13B Low 1.12B Close 1.13B ▼ Falling`, matching the
  stored candle exactly while its neighbours differ. Verifying it found **two
  bugs, both fixed**:
  1. *Stale readout after re-layout.* The crosshair label said 26 Feb while
     the readout showed the 2 March bar — the pointer event fired before the
     time scale finished laying out. The readout now clears on any visible
     range change.
  2. *The readout rounded away the numbers it exists to show.* It reused the
     axis formatter, so a BTCIDR 1m bar read `1.46B` for all four values while
     actually moving 1,459,704,000 → 1,458,403,000. Readout and table now use
     exact prices; only the axis is compacted. The in-progress bar is also
     now labelled in the table.
- Real screen-reader output (VoiceOver/NVDA). The markup follows the rules; how
  it actually sounds was not heard.
- Printed/greyscale rendering of the hollow candles.
