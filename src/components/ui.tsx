import type { ReactNode } from 'react';
import type { DataQuality } from '@/lib/market/types';
import { Hint, HintMark } from './hint';
import { formatAge, formatUtc } from '@/lib/format';

/**
 * Shared presentational primitives.
 *
 * The data-provenance components (DataQualityBadge, DataSourceLine) are the
 * most important ones in the app: every market-dependent view must state
 * whether what you are looking at is live, cached, delayed, stale or absent.
 */

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-line bg-bg-raised ${className}`}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-2xs text-ink-muted">{subtitle}</p>}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const QUALITY_CLASS: Record<DataQuality, string> = {
  ok: 'bg-up-dim text-up border-up/30',
  delayed: 'bg-warn-dim text-warn border-warn/30',
  stale: 'bg-warn-dim text-warn border-warn/30',
  insufficient: 'bg-down-dim text-down border-down/30',
  invalid: 'bg-down-dim text-down border-down/30',
  unavailable: 'bg-bg-inset text-ink-faint border-line-strong',
};

export interface QualityLabels {
  ok: string;
  delayed: string;
  stale: string;
  insufficient: string;
  invalid: string;
  unavailable: string;
  okHelp: string;
  delayedHelp: string;
  staleHelp: string;
  insufficientHelp: string;
  invalidHelp: string;
  unavailableHelp: string;
}

const HELP_KEY: Record<DataQuality, keyof QualityLabels> = {
  ok: 'okHelp',
  delayed: 'delayedHelp',
  stale: 'staleHelp',
  insufficient: 'insufficientHelp',
  invalid: 'invalidHelp',
  unavailable: 'unavailableHelp',
};

export function DataQualityBadge({ quality, labels }: { quality: DataQuality; labels: QualityLabels }) {
  return (
    <span
      data-hint={labels[HELP_KEY[quality]]}
      title={labels[HELP_KEY[quality]]}
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-2xs font-semibold tracking-wide ${QUALITY_CLASS[quality]}`}
    >
      {labels[quality]}
    </span>
  );
}

/** Provenance line: provider, when fetched, and whether it came from cache. */
export function DataSourceLine({
  provider,
  fetchedAtMs,
  fromCache,
  extra,
  labels,
}: {
  provider: string | null;
  fetchedAtMs: number | null;
  fromCache?: boolean;
  extra?: string;
  labels: { source: string; retrieved: string; fromCache: string; none: string };
}) {
  return (
    <p className="text-2xs text-ink-faint">
      {labels.source}: <span className="text-ink-muted">{provider ?? labels.none}</span>
      {fetchedAtMs ? (
        <>
          {' · '}
          {labels.retrieved} <span className="text-ink-muted">{formatUtc(fetchedAtMs)}</span> ({formatAge(fetchedAtMs)})
        </>
      ) : null}
      {fromCache ? ` · ${labels.fromCache}` : null}
      {extra ? ` · ${extra}` : null}
    </p>
  );
}

const ACTION_STYLES: Record<string, string> = {
  BUY: 'bg-up-dim text-up border-up/40',
  SELL: 'bg-down-dim text-down border-down/40',
  HOLD: 'bg-accent-dim text-accent border-accent/40',
  WAIT: 'bg-bg-inset text-ink-muted border-line-strong',
};

export function ActionBadge({
  action,
  size = 'sm',
  hint,
}: {
  action: string;
  size?: 'sm' | 'lg';
  /** Plain-language explanation of what this action means. */
  hint?: string;
}) {
  const badge = (
    <span
      className={`inline-flex items-center rounded border font-bold tracking-wide ${
        ACTION_STYLES[action] ?? ACTION_STYLES.WAIT
      } ${size === 'lg' ? 'px-2.5 py-1 text-sm' : 'px-1.5 py-0.5 text-2xs'}`}
    >
      {action}
    </span>
  );
  return hint ? <Hint text={hint}>{badge}</Hint> : badge;
}

export interface StrengthLabels {
  insufficient: string;
  weak: string;
  moderate: string;
  strong: string;
  help: string;
}

export function StrengthBadge({ strength, labels }: { strength: string; labels: StrengthLabels }) {
  const tone =
    strength === 'strong'
      ? 'text-up border-up/30'
      : strength === 'moderate'
        ? 'text-accent border-accent/30'
        : strength === 'weak'
          ? 'text-warn border-warn/30'
          : 'text-ink-faint border-line-strong';
  return (
    <span
      data-hint={labels.help}
      title={labels.help}
      className={`inline-flex items-center rounded border bg-bg-inset px-1.5 py-0.5 text-2xs font-medium ${tone}`}
    >
      {labels[strength as keyof StrengthLabels] ?? strength}
    </span>
  );
}

export function RegimeBadge({ regime }: { regime: string }) {
  const tone =
    regime === 'uptrend'
      ? 'text-up'
      : regime === 'downtrend'
        ? 'text-down'
        : regime === 'high_volatility'
          ? 'text-warn'
          : 'text-ink-muted';
  return <span className={`text-2xs font-medium uppercase tracking-wide ${tone}`}>{regime.replace(/_/g, ' ')}</span>;
}

/**
 * Empty state.
 *
 * The icon is an inline SVG rather than a text glyph: a character rendered at
 * 2xl depends on whatever font happens to resolve, and it was being announced
 * by screen readers as a stray em-dash. It is decorative, so it is hidden from
 * the accessibility tree and the text carries the meaning.
 */
export function EmptyState({ title, body, icon }: { title: string; body: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded border border-dashed border-line-strong px-6 py-10 text-center">
      <span aria-hidden="true" className="mb-2 text-ink-faint">
        {icon ?? (
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 10h18M9 10v10" strokeLinecap="round" />
          </svg>
        )}
      </span>
      <p className="text-sm font-medium text-ink-muted">{title}</p>
      <p className="mt-1 max-w-md text-2xs text-ink-faint">{body}</p>
    </div>
  );
}

export function ErrorState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded border border-down/30 bg-down-dim/40 px-4 py-3">
      <p className="text-sm font-medium text-down">{title}</p>
      <p className="mt-1 whitespace-pre-wrap text-2xs text-ink-muted">{detail}</p>
    </div>
  );
}

export function WarningNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-warn/30 bg-warn-dim/40 px-3 py-2 text-2xs text-warn">{children}</div>
  );
}

export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-line-strong bg-bg-inset px-3 py-2 text-2xs text-ink-muted">{children}</div>
  );
}

/** Marks content produced by a language model, never by deterministic code. */
export function AiBadge({
  status,
  provider,
  labels,
}: {
  status: string;
  provider?: string | null;
  labels: { aiHelp: string; aiCached: string };
}) {
  const ok = status === 'ok' || status === 'cached';
  return (
    <span
      data-hint={labels.aiHelp}
      title={labels.aiHelp}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs font-medium ${
        ok ? 'border-accent/40 bg-accent-dim text-accent' : 'border-line-strong bg-bg-inset text-ink-faint'
      }`}
    >
      AI{status === 'cached' ? ` (${labels.aiCached})` : ''}
      {ok && provider ? ` · ${provider}` : ''}
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = '',
  hint,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
  /** Plain-language explanation shown on hover or tap. */
  hint?: string;
}) {
  return (
    <div className="rounded border border-line bg-bg-inset px-3 py-2">
      <p className="text-2xs uppercase tracking-wide text-ink-faint">
        {label}
        {hint && <HintMark text={hint} />}
      </p>
      <p className={`figure mt-1 text-lg font-semibold ${tone}`}>{value}</p>
      {sub && <p className="mt-0.5 text-2xs text-ink-muted">{sub}</p>}
    </div>
  );
}

/**
 * Dense data table.
 *
 * Three things changed in the UX pass:
 *  - `scope="col"` on every header. Without it a screen reader reading a cell
 *    in the middle of a 13-column scan table cannot say which column it is in,
 *    which is exactly where the information lives.
 *  - An optional `caption`. It names the table for assistive tech, and is the
 *    only way to answer "what am I looking at" without the surrounding card.
 *  - The scroll wrapper is focusable and labelled. A region that scrolls must
 *    be reachable by keyboard, or a keyboard user simply cannot see the
 *    right-hand columns of a 13-column scan table.
 *
 * Deliberately NOT sticky: `overflow-x-auto` makes this div a scroll container
 * on both axes, and it has no height constraint, so it never scrolls
 * vertically — `position: sticky` on the header would resolve against this
 * container and do nothing. A sticky header here needs a `max-height` on the
 * wrapper first; the header keeps its own background and bottom border so that
 * change stays a one-liner.
 */
export function Table({
  head,
  caption,
  children,
}: {
  head: ReactNode[];
  /** Accessible name for the table. Visually hidden. */
  caption?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="-mx-4 overflow-x-auto px-4"
      tabIndex={0}
      /*
       * Only claim the landmark when it has a name. An unnamed `role="region"`
       * is worse than none: it adds an anonymous landmark to the page outline
       * that a screen-reader user has to step through and cannot identify.
       */
      {...(caption ? { role: 'region', 'aria-label': caption } : {})}
    >
      <table className="w-full min-w-[640px] border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="text-left text-2xs uppercase tracking-wide text-ink-faint">
            {head.map((h, i) => (
              <th
                key={i}
                scope="col"
                className="whitespace-nowrap border-b border-line bg-bg-raised px-2 py-2 font-medium"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">{children}</tbody>
      </table>
    </div>
  );
}

export function Disclaimer({ text }: { text: string }) {
  return <p className="text-2xs leading-relaxed text-ink-faint">{text}</p>;
}
