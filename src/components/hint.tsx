import type { ReactNode } from 'react';

/**
 * Explanation tooltips.
 *
 * ARCHITECTURE: the trigger carries the text in `data-hint` and renders NO
 * panel of its own. A single client component (`HintLayer`, mounted once in
 * the layout) renders one shared panel and positions it against the viewport.
 *
 * Why not pure CSS: a CSS-only panel cannot measure the viewport, so it is
 * clipped whenever the trigger sits near an edge — on the Evaluation page that
 * was 18 of 72 tooltips. Hand-tagging each call site with a side does not scale
 * and breaks whenever a column moves.
 *
 * Why not one client component per tooltip: a single page can carry 70+ hints;
 * one shared listener costs far less than 70 hydrated components.
 *
 * `title` is kept as a no-JavaScript fallback.
 *
 * ACCESSIBILITY NOTES (changed in the UX pass):
 *  - These are real `<button>`s, not spans with `role="button"`. The previous
 *    version promised a button role but handled no key events, so Enter and
 *    Space did nothing. A real button gets that for free.
 *  - `Hint` no longer sets `aria-label`. It wraps visible content (a BUY badge,
 *    a number), and an aria-label REPLACES that content for a screen reader —
 *    so the old markup announced the explanation and swallowed the value. The
 *    explanation now rides along in an `sr-only` span, giving "BUY, <meaning>".
 *  - `HintMark` keeps `aria-label`, because there it is the only content.
 */

export function Hint({
  text,
  children,
  className = '',
}: {
  text: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-hint={text}
      title={text}
      className={`inline-flex cursor-help items-center border-b border-dotted border-ink-faint/60 text-left align-baseline ${className}`}
    >
      {children}
      <span className="sr-only">. {text}</span>
    </button>
  );
}

/**
 * A small "?" marker next to a label.
 *
 * 18px visual box so the glyph is legible, with `.tap-24` expanding the hit
 * area to the 24x24 CSS px that WCAG 2.2 AA (2.5.8) requires on the web —
 * without making the box itself 24px, which would push every dense table row
 * taller. The previous marker was 12x12 with an 8px glyph.
 */
export function HintMark({ text }: { text: string }) {
  return (
    <button
      type="button"
      data-hint={text}
      aria-label={text}
      title={text}
      className="tap-24 ml-1 inline-flex h-[18px] w-[18px] shrink-0 cursor-help items-center justify-center rounded-full border border-ink-faint/50 align-middle text-2xs leading-none text-ink-faint transition-colors hover:border-accent hover:text-accent"
    >
      <span aria-hidden="true">?</span>
    </button>
  );
}

/** A table-header label with an attached explanation. */
export function HeadHint({ label, text }: { label: string; text: string }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap">
      {label}
      <HintMark text={text} />
    </span>
  );
}
