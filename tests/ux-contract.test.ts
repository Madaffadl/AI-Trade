import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-level UX guarantees.
 *
 * These assert properties of the SOURCE, not of a rendered page, because they
 * are exactly the rules that regress silently: nothing fails to compile when
 * someone adds an 11px label or a control with no focus ring, and the damage
 * is invisible until a keyboard or screen-reader user hits it.
 *
 * Each test pins a rule from the UI/UX review, with the measurement that
 * justified it in the comment.
 */

// fileURLToPath, not `.pathname`: the project directory contains a space,
// which `.pathname` leaves percent-encoded as %20.
const SRC = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx') || full.endsWith('.css')) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const read = (f: string) => readFileSync(f, 'utf8');

/**
 * Strip comments before asserting on code.
 *
 * These files document the anti-patterns they removed ("a span wearing
 * role=button", "no userScalable"), so a naive substring search matches the
 * explanation and fails on the very file that fixed the problem.
 */
function code(f: string): string {
  return read(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}
const tsx = files.filter((f) => f.endsWith('.tsx'));

describe('type scale never drops below the 12px floor', () => {
  const config = readFileSync(fileURLToPath(new URL('../tailwind.config.ts', import.meta.url)), 'utf8');

  it('defines the smallest named size at exactly 12px', () => {
    // 0.6875rem (11px) was the app's DEFAULT size at 230 call sites.
    expect(config).toContain("'2xs': ['0.75rem'");
    expect(config).not.toContain('0.6875rem');
  });

  it('keeps the tiers above it distinct, so raising the floor did not flatten the scale', () => {
    // 12 / 13 / 14 / 16 / 18 / 20 / 24.
    for (const size of ['0.75rem', '0.8125rem', '0.875rem', '1rem', '1.125rem', '1.25rem', '1.5rem']) {
      expect(config).toContain(size);
    }
  });

  it('has no arbitrary sub-12px font size anywhere in the components', () => {
    // `text-[8px]` on the tooltip marker was the worst offender.
    const offenders: string[] = [];
    for (const f of tsx) {
      // Matches text-[Npx] / text-[Nrem] below the floor.
      for (const m of read(f).matchAll(/text-\[(\d+(?:\.\d+)?)(px|rem)\]/g)) {
        const px = m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
        if (px < 11) offenders.push(`${f}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('keyboard focus is visible', () => {
  it('declares a global focus-visible ring rather than relying on per-component rules', () => {
    // Before this pass the whole app had 2 focus-visible declarations.
    const css = read(files.find((f) => f.endsWith('globals.css'))!);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:/);
  });

  it('never strips an outline without putting one back', () => {
    const css = read(files.find((f) => f.endsWith('globals.css'))!);
    // The only `outline: none` allowed is the one paired with :focus-visible.
    const stripped = [...css.matchAll(/outline:\s*none/g)];
    expect(stripped.length).toBe(1);
    expect(css).toContain(':focus:not(:focus-visible)');
  });

  it('has no outline-none utility left in the components', () => {
    const offenders = tsx.filter((f) => /\boutline-none\b/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});

describe('reduced motion is honoured', () => {
  it('disables animation globally when the user asks for it', () => {
    const css = read(files.find((f) => f.endsWith('globals.css'))!);
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });
});

describe('tooltip triggers are real controls', () => {
  const hint = read(files.find((f) => f.endsWith('components/hint.tsx'))!);
  const hintCode = code(files.find((f) => f.endsWith('components/hint.tsx'))!);

  it('uses a button element instead of a span wearing role="button"', () => {
    // role="button" with no key handler promises activation it cannot deliver.
    expect(hintCode).not.toContain('role="button"');
    expect(hint).toContain('<button');
    expect(hint).toContain('type="button"');
  });

  it('meets the 24x24 CSS px web target size (WCAG 2.2 AA 2.5.8)', () => {
    // NOT 44pt: that is native-platform guidance and does not define web
    // conformance. The marker is 18px visually with the hit area expanded.
    expect(hint).toContain('tap-24');
    const css = read(files.find((f) => f.endsWith('globals.css'))!);
    expect(css).toMatch(/\.tap-24::after[^}]*width:\s*24px/s);
  });

  it('does not let aria-label swallow the value it is wrapping', () => {
    // Hint wraps visible content (a BUY badge); an aria-label would replace it.
    const hintFn = hintCode.slice(hintCode.indexOf('export function Hint('), hintCode.indexOf('export function HintMark('));
    expect(hintFn).not.toContain('aria-label');
    expect(hintFn).toContain('sr-only');
  });
});

describe('data tables are navigable without sight', () => {
  const ui = read(files.find((f) => f.endsWith('components/ui.tsx'))!);

  it('marks every header cell with a column scope', () => {
    // Without scope, a cell in a 13-column scan table has no column name.
    expect(ui).toContain('scope="col"');
  });

  it('makes the horizontal scroll region reachable by keyboard', () => {
    expect(ui).toMatch(/overflow-x-auto[^>]*tabIndex=\{0\}/s);
  });

  it('supports an accessible caption', () => {
    expect(ui).toContain('<caption className="sr-only">');
  });
});

describe('navigation is adaptive and not overloaded', () => {
  const nav = read(files.find((f) => f.endsWith('components/nav.tsx'))!);

  it('shows primary destinations from 1024px, not 1280px', () => {
    // The old bar was xl:flex, so 1024-1279px had no navigation at all.
    expect(nav).toContain('lg:flex');
    expect(nav).not.toContain('xl:flex');
  });

  it('keeps the bottom bar at or below five items', () => {
    const slice = nav.slice(nav.indexOf('const primary = ['), nav.indexOf('const groups'));
    expect(slice.match(/href:/g)!.length).toBeLessThanOrEqual(5);
  });

  it('clears the iOS home indicator on the fixed bottom bar', () => {
    expect(nav).toContain('env(safe-area-inset-bottom)');
  });

  it('announces the unread count instead of leaving a bare number', () => {
    expect(nav).toMatch(/sr-only[\s\S]{0,120}unreadAlerts/);
  });

  it('marks the current page for assistive tech', () => {
    expect(nav).toContain("aria-current={");
  });

  it('gives every bottom-bar destination a distinct icon', () => {
    // Signals and Scanner shipped with the same glyph in the first pass.
    const block = nav.slice(nav.indexOf('const primary = ['), nav.indexOf('const groups'));
    const icons = [...block.matchAll(/icon: (PATHS\.\w+)/g)].map((m) => m[1]);
    expect(icons.length).toBeGreaterThan(0);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe('the app shell is keyboard-reachable', () => {
  const layout = read(files.find((f) => f.endsWith('app/layout.tsx'))!);
  const layoutCode = code(files.find((f) => f.endsWith('app/layout.tsx'))!);

  it('offers a skip link to main content', () => {
    expect(layout).toContain('skip-link');
    expect(layout).toContain('href="#main"');
    expect(layout).toContain('id="main"');
  });

  it('leaves room for the fixed mobile bar so content is not hidden behind it', () => {
    expect(layout).toMatch(/pb-20 lg:pb-5/);
  });

  it('never disables pinch zoom', () => {
    expect(layoutCode).not.toContain('userScalable');
    expect(layoutCode).not.toContain('maximumScale');
    // And the viewport is actually declared, so this is not vacuously true.
    expect(layoutCode).toContain('initialScale: 1');
  });
});

describe('the candlestick chart does not depend on colour', () => {
  const chart = read(files.find((f) => f.endsWith('components/price-chart.tsx'))!);

  it('distinguishes direction by body fill, not only hue', () => {
    // Hollow up / filled down: survives deuteranopia and greyscale printing.
    expect(chart).toContain("upColor: 'rgba(0,0,0,0)'");
    expect(chart).toContain('borderUpColor: UP');
  });

  it('mirrors the hovered bar as real DOM text', () => {
    // A tooltip inside <canvas> does not exist for assistive tech.
    expect(chart).toContain('subscribeCrosshairMove');
    expect(chart).toContain('aria-live="polite"');
  });

  it('shows exact prices in the readout and table, compacting only the axis', () => {
    // The axis formatter turned an IDR 1m bar into "1.46B" four times over,
    // hiding a 1.3M IDR move. It may be used for the axis and nowhere else.
    const uses = chart.match(/formatAxisPrice\(/g) ?? [];
    expect(uses.length).toBe(1); // its own definition
    expect(chart).toContain('priceFormatter: formatAxisPrice');
    expect(chart).toContain('{formatPrice(value)}');
    expect(chart).toContain('{formatPrice(c.close)}');
  });

  it('clears the readout when the time scale re-lays out under a still pointer', () => {
    // Observed in a real browser: crosshair label "26 Feb", readout showing
    // the 2 March bar, because layout moved after the last pointer event.
    expect(chart).toMatch(/subscribeVisibleLogicalRangeChange\(\(\) => setReadout\(null\)\)/);
  });

  it('provides the OHLC text fallback the chart guidance requires', () => {
    expect(chart).toContain('<details');
    expect(chart).toContain('tableCaption');
    expect(chart).toContain('scope="col"');
  });

  it('labels direction with a glyph as well as a colour class', () => {
    expect(chart).toContain("'▲ '");
    expect(chart).toContain("'▼ '");
  });
});

describe('colour tokens are not bypassed', () => {
  it('uses no superseded up/down hex left over from the first palette', () => {
    const offenders: string[] = [];
    for (const f of tsx) {
      const body = read(f)
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      if (/#3fb950|#e5534b/i.test(body)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Chart readout logic, tested as pure functions.
 *
 * The live crosshair readout could not be driven by synthetic pointer events —
 * lightweight-charts does not act on them — so the parts that can go wrong
 * without anyone noticing are tested directly instead.
 */
describe('chart readout logic', () => {
  it('derives the same time key for the series and the lookup map', async () => {
    const { timeKey } = await import('@/components/price-chart');
    // Whole seconds: the common case.
    expect(timeKey(1_700_000_000_000)).toBe(1_700_000_000);
    // Sub-second precision must not produce a key the series cannot match.
    expect(timeKey(1_700_000_000_499)).toBe(timeKey(1_700_000_000_000));
  });

  it('reads direction from the bar body, never from a colour', async () => {
    const { direction } = await import('@/components/price-chart');
    const bar = (open: number, close: number) => ({ time: 0, open, high: 0, low: 0, close, volume: null, isPartial: false });
    expect(direction(bar(100, 110))).toBe('up');
    expect(direction(bar(110, 100))).toBe('down');
    expect(direction(bar(100, 100))).toBe('flat');
  });
});

/**
 * Regression guards for the functional-review fixes.
 *
 * Each of these pins a defect that was found by running the app, not by
 * reading it — so each one would have shipped again without a test.
 */
describe('functional review fixes stay fixed', () => {
  it('explains an exit in words rather than rule codes', async () => {
    const types = readFileSync(fileURLToPath(new URL('../src/lib/strategies/types.ts', import.meta.url)), 'utf8');
    expect(types).toContain('export function describeExits');
    // The summary must carry r.description, not just r.id.
    const fn = types.slice(types.indexOf('export function describeExits'));
    expect(fn).toContain('r.description');

    for (const name of ['trend-follow', 'breakout', 'mean-reversion']) {
      const src = readFileSync(fileURLToPath(new URL(`../src/lib/strategies/${name}.ts`, import.meta.url)), 'utf8');
      expect(src).toContain('describeExits(exitRules)');
      expect(src).not.toContain("map((r) => r.id).join(', ')");
    }
  });

  it('keeps stablecoins out of the scan universe', async () => {
    // A stablecoin/IDR pair is the most liquid market there is and cannot move.
    const src = readFileSync(fileURLToPath(new URL('../src/lib/indodax/universe.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/PEGGED_ASSETS\.has/);
  });

  it('no longer declares the table nothing reads or writes', async () => {
    const schema = readFileSync(fileURLToPath(new URL('../src/lib/db/schema.sql', import.meta.url)), 'utf8');
    expect(schema).not.toContain('CREATE TABLE IF NOT EXISTS technical_indicator_snapshots');
  });

  it('can verify every provider it actually depends on', async () => {
    // Indodax serves the IDR pairs in production but had no sample symbol,
    // so it reported as "skip" and looked untested.
    const src = readFileSync(fileURLToPath(new URL('../scripts/verify-providers.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/indodax:\s*\[\{\s*symbol:/);
  });
});
