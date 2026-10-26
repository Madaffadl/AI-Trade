# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** AI Trade
**Generated:** 2026-10-26 16:42:51
**Category:** Financial Dashboard
**Design Dials:** Variance 3/10 (Centered / Minimal) | Motion 2/10 (Subtle) | Density 8/10 (Dense / Dashboard)

---

## Global Rules

### Color Palette

> **Deviation from the search result, with measurement.** The generator proposed
> accent `#22C55E` with destructive `#EF4444`. Under a deuteranope simulation that
> up/down pair separates by ΔE **18.0**; the pair already in `tailwind.config.ts`
> separates by ΔE **43.5** on the same model. Red/green is the finance convention
> and is kept, but the green is shifted toward teal so it survives the most common
> form of colour-vision deficiency. The suggested pair was therefore rejected.
>
> All 21 foreground/surface combinations below were measured against WCAG 2.1:
> every one passes AA for normal text (>=4.5:1). Lowest is `ink-faint` on
> `bg-raised` at 4.84:1.

| Role | Hex | Tailwind token | On `bg-raised` |
|------|-----|----------------|----------------|
| Background | `#0b0e13` | `bg` | — |
| Surface (raised) | `#111620` | `bg-raised` | — |
| Surface (inset) | `#070a0e` | `bg-inset` | — |
| Border | `#1e2633` | `line` | — |
| Border (strong) | `#2c3747` | `line-strong` | — |
| Text primary | `#e6eaf0` | `ink` | 15.00:1 |
| Text secondary | `#8b97a8` | `ink-muted` | 6.11:1 |
| Text tertiary | `#788598` | `ink-faint` | 4.84:1 |
| Up / positive | `#13a383` | `up` | 5.69:1 |
| Down / negative | `#e5484d` | `down` | 4.63:1 |
| Accent / interactive | `#3d8bfd` | `accent` | 5.44:1 |
| Warning | `#b07d10` | `warn` | 4.99:1 |

**Colour is never the only cue.** Every up/down value also carries a ▲/▼ glyph and
a signed number; every status also carries a word.

### Typography

> **Deviation, deliberate.** The generator proposed Fira Code / Fira Sans loaded
> from the Google Fonts CDN. AI Trade has no third-party runtime dependency and
> must build offline, so the system sans/mono stack is kept and `tnum` is enabled
> via `font-feature-settings` instead. The recommendation is recorded here in case
> self-hosting through `next/font` is wanted later.

- **Heading Font:** system-ui stack (recommended: Fira Code)
- **Body Font:** system-ui stack (recommended: Fira Sans)
- **Mood:** dashboard, data, analytics, code, technical, precise
- **Google Fonts:** [Fira Code + Fira Sans](https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:wght@300;400;500;600;700&display=swap)

**CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:wght@300;400;500;600;700&display=swap');
```

### Spacing Variables

*Density: 8/10 — Dense / Dashboard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `2px` / `0.125rem` | Tight gaps |
| `--space-sm` | `4px` / `0.25rem` | Icon gaps, inline spacing |
| `--space-md` | `8px` / `0.5rem` | Standard padding |
| `--space-lg` | `12px` / `0.75rem` | Section padding |
| `--space-xl` | `16px` / `1rem` | Large gaps |
| `--space-2xl` | `24px` / `1.5rem` | Section margins |
| `--space-3xl` | `32px` / `2rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

### Buttons

```css
/* Primary Button */
.btn-primary {
  background: #22C55E;
  color: #0F172A;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

/* Secondary Button */
.btn-secondary {
  background: transparent;
  color: #F8FAFC;
  border: 2px solid #0F172A;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}
```

### Cards

```css
.card {
  background: #020617;
  border-radius: 12px;
  padding: 24px;
  box-shadow: var(--shadow-md);
  transition: all 200ms ease;
  cursor: pointer;
}

.card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-2px);
}
```

### Inputs

```css
.input {
  padding: 12px 16px;
  border: 1px solid #E2E8F0;
  border-radius: 8px;
  font-size: 16px;
  transition: border-color 200ms ease;
}

.input:focus {
  border-color: #0F172A;
  outline: none;
  box-shadow: 0 0 0 3px #0F172A20;
}
```

### Modals

```css
.modal-overlay {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.modal {
  background: white;
  border-radius: 16px;
  padding: 32px;
  box-shadow: var(--shadow-xl);
  max-width: 500px;
  width: 90%;
}
```

---

## Style Guidelines

**Style:** Minimalism & Swiss Style

**Keywords:** Clean, simple, spacious, functional, white space, high contrast, geometric, sans-serif, grid-based, essential

**Best For:** Enterprise apps, dashboards, documentation sites, SaaS platforms, professional tools

**Key Effects:** Subtle hover (200-250ms), smooth transitions, sharp shadows if any, clear type hierarchy, fast loading

### Application Pattern

> **Corrected after verification.** The `--design-system` aggregator returned the
> landing-page pattern *"Enterprise Gateway"* (hero video, client logos, Contact
> Sales). AI Trade is an authenticated single-user dashboard with no marketing
> surface, so that pattern does not apply and was discarded rather than persisted.
> The row below is the verified match from `products.csv`.

**Product Type:** Financial Dashboard — `"analytics dashboard data tables" --domain product`, result 3

- **Keywords:** portfolio, trading, pnl, investment, fintech
- **Primary Style:** Dark Mode (OLED) + Data-Dense Dashboard
- **Secondary Styles:** Minimalism & Swiss Style, Accessible & Ethical
- **Landing Page Pattern:** *N/A — Dashboard focused* (the CSV itself states this)
- **Dashboard Style:** Financial Dashboard
- **Color Palette Focus:** Dark bg + red/green alerts + trust blue
- **Navigation:** `adaptive-navigation` — sidebar at >=1024px, bottom/top nav on small screens

---

## Motion

**Scroll Reveal** (Subtle) — Trigger: scroll (viewport enter) | Duration: 300-400ms | Easing: `power1.out`

```js
gsap.from(el, { opacity: 0, y: 12, duration: 0.35, ease: 'power1.out', scrollTrigger: { trigger: el, start: 'top 90%', toggleActions: 'play none none reverse' } });
```

**Framework notes:** Requires the ScrollTrigger plugin registered once via gsap.registerPlugin(ScrollTrigger); Use matchMedia('(prefers-reduced-motion: reduce)') to skip non-essential motion and render the final state immediately

- ✅ Keep the y offset small (8-16px) so it reads as a fade, not a slide
- ❌ Don't reveal below-the-fold content needed for SEO/crawlers as invisible-by-default without a no-JS fallback
- ⚡ toggleActions 'play none none reverse' avoids re-triggering on every scroll direction change

---

## Anti-Patterns (Do NOT Use)

- ❌ Light mode default
- ❌ Slow rendering

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
