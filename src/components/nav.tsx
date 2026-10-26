'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Locale } from '@/lib/i18n/types';
import { CurrencyToggle } from './currency-toggle';
import { LanguageToggle } from './language-toggle';

export interface NavLabels {
  brand: string;
  personal: string;
  overview: string;
  markets: string;
  scanner: string;
  watchlist: string;
  portfolio: string;
  signals: string;
  news: string;
  forecasts: string;
  history: string;
  evaluation: string;
  settings: string;
  alerts: string;
  menu: string;
  toggleNav: string;
  currencyTitle: string;
  currencyNative: string;
  languageTitle: string;
  more: string;
  moreTitle: string;
  groupTrade: string;
  groupResearch: string;
  groupReview: string;
  primaryNav: string;
  skipToContent: string;
  unreadAlerts: string;
  close: string;
  recommendations: string;
}

/**
 * Icons for the mobile bottom bar.
 *
 * Inline SVG from one family, one 1.5 stroke width, one 20px box — the pro
 * rules call out mixed stroke weights and arbitrary icon sizes as the thing
 * that makes an interface read as unfinished. They sit beside visible text
 * labels, so they are decorative and hidden from the accessibility tree.
 */
const ICON = 'h-5 w-5 shrink-0';

function Icon({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      className={ICON}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

const PATHS = {
  overview: 'M3 13h4l3 6 4-14 3 8h4',
  signals: 'M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5',
  portfolio: 'M3 7h18v12H3zM3 7l2-3h14l2 3M9 12h6',
  markets: 'M4 19V9m5 10V5m5 14v-7m5 7V7',
  // Scanner needs its own glyph: it previously reused the signals icon, which
  // gave two different destinations the same mark in a five-item bottom bar.
  scanner: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
};

export function Nav({
  unreadCount,
  currency,
  locale,
  labels,
}: {
  unreadCount: number;
  currency: string;
  locale: Locale;
  labels: NavLabels;
}) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  /*
   * NAVIGATION STRUCTURE (changed in the UX pass).
   *
   * Before: eleven equal-weight links in one row, shown only at `xl` (1280px)
   * and otherwise collapsed behind a "Menu" button. Two problems. Eleven
   * undifferentiated destinations is the overloaded-nav anti-pattern — nothing
   * tells you where to start. And on every laptop between 1024px and 1279px
   * the whole navigation disappeared, which is the single most common desktop
   * width there is.
   *
   * After: five primary destinations, ordered by the actual workflow (check a
   * signal -> look at the product -> record what you bought -> review), with
   * the remaining six grouped under "More". Primary links now appear from
   * `lg` (1024px), and below that a bottom bar carries the same five — the
   * adaptive-navigation rule (sidebar/inline at >=1024px, bottom nav on small
   * screens) and the <=5 bottom-nav limit.
   */
  const primary = [
    { href: '/', label: labels.overview, icon: PATHS.overview },
    { href: '/signals', label: labels.signals, icon: PATHS.signals },
    { href: '/portfolio', label: labels.portfolio, icon: PATHS.portfolio },
    { href: '/scanner', label: labels.scanner, icon: PATHS.scanner },
    { href: '/markets', label: labels.markets, icon: PATHS.markets },
  ];

  const groups: { title: string; links: { href: string; label: string }[] }[] = [
    {
      title: labels.groupTrade,
      links: [
        { href: '/watchlist', label: labels.watchlist },
        { href: '/recommendations', label: labels.recommendations },
        { href: '/alerts', label: labels.alerts },
      ],
    },
    {
      title: labels.groupResearch,
      links: [
        { href: '/news', label: labels.news },
        { href: '/forecasts', label: labels.forecasts },
      ],
    },
    {
      title: labels.groupReview,
      links: [
        { href: '/history', label: labels.history },
        { href: '/evaluation', label: labels.evaluation },
        { href: '/settings', label: labels.settings },
      ],
    },
  ];

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const moreActive = groups.some((g) => g.links.some((l) => isActive(l.href)));

  // Close the menu on outside click and on Escape, and return focus to the
  // trigger — a menu you can open but not dismiss by keyboard is a focus trap.
  useEffect(() => {
    if (!moreOpen) return;
    function onDown(e: MouseEvent) {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMoreOpen(false);
        moreRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  /*
   * Close the menu when the route changes.
   *
   * Done DURING RENDER by comparing against the last-seen path, not in an
   * effect. `useEffect(() => setMoreOpen(false), [pathname])` rendered the
   * stale open menu first and then re-rendered to close it — a wasted render
   * on every navigation, which the React Compiler lint rule
   * `react-hooks/set-state-in-effect` (new in eslint-config-next 16) flags.
   * This is React's documented "adjusting state when a prop changes" pattern,
   * and unlike closing in each link's onClick it also covers back/forward.
   */
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setMoreOpen(false);
  }

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 py-2">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 rounded px-1 py-1.5 transition-colors hover:bg-bg-raised"
          >
            <span className="text-sm font-bold tracking-tight text-ink">{labels.brand}</span>
            <span className="hidden rounded border border-line-strong px-1 py-px text-2xs text-ink-faint sm:inline">
              {labels.personal}
            </span>
          </Link>

          <nav aria-label={labels.primaryNav} className="hidden flex-1 items-center gap-1 lg:flex">
            {primary.map((l) => (
              <NavLink key={l.href} href={l.href} active={isActive(l.href)}>
                {l.label}
              </NavLink>
            ))}

            <div className="relative" ref={moreRef}>
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                aria-expanded={moreOpen}
                aria-haspopup="true"
                className={`inline-flex min-h-[36px] items-center gap-1 rounded px-3 py-2 text-xs font-medium transition-colors ${
                  moreActive || moreOpen ? 'bg-bg-raised text-ink' : 'text-ink-muted hover:bg-bg-raised hover:text-ink'
                }`}
              >
                {labels.more}
                <svg
                  aria-hidden="true"
                  className={`h-3 w-3 transition-transform ${moreOpen ? 'rotate-180' : ''}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>

              {moreOpen && (
                <div
                  role="group"
                  aria-label={labels.moreTitle}
                  className="absolute left-0 top-full mt-1 w-56 rounded-lg border border-line-strong bg-bg-raised p-2 shadow-xl"
                >
                  {groups.map((g) => (
                    <div key={g.title} className="mb-1 last:mb-0">
                      <p className="px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
                        {g.title}
                      </p>
                      {g.links.map((l) => (
                        <Link
                          key={l.href}
                          href={l.href}
                          className={`block min-h-[32px] rounded px-2 py-1.5 text-xs transition-colors ${
                            isActive(l.href)
                              ? 'bg-accent-dim text-accent'
                              : 'text-ink-muted hover:bg-bg-inset hover:text-ink'
                          }`}
                        >
                          {l.label}
                        </Link>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <LanguageToggle current={locale} title={labels.languageTitle} />
            <CurrencyToggle current={currency} title={labels.currencyTitle} nativeLabel={labels.currencyNative} />
            <Link
              href="/alerts"
              className="relative inline-flex min-h-[32px] items-center rounded border border-line px-2.5 py-1 text-2xs text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
            >
              {labels.alerts}
              {unreadCount > 0 && (
                <>
                  <span
                    aria-hidden="true"
                    className="ml-1.5 rounded bg-accent px-1 py-px text-2xs font-semibold text-bg"
                  >
                    {unreadCount}
                  </span>
                  {/* The bare number above is meaningless to a screen reader. */}
                  <span className="sr-only">
                    , {unreadCount} {labels.unreadAlerts}
                  </span>
                </>
              )}
            </Link>
          </div>
        </div>
      </header>

      {/*
        Mobile bottom navigation: the same five primary destinations, never
        more. `pb-[env(safe-area-inset-bottom)]` keeps the row clear of the
        iOS home indicator; the matching spacer lives in the layout so page
        content is never hidden behind this bar.
      */}
      <nav
        aria-label={labels.primaryNav}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <ul className="mx-auto flex max-w-lg items-stretch">
          {primary.slice(0, 4).map((l) => (
            <li key={l.href} className="flex-1">
              <Link
                href={l.href}
                aria-current={isActive(l.href) ? 'page' : undefined}
                className={`flex min-h-[52px] flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[11px] leading-tight transition-colors ${
                  isActive(l.href) ? 'text-accent' : 'text-ink-muted'
                }`}
              >
                <Icon d={l.icon} />
                <span className="truncate">{l.label}</span>
              </Link>
            </li>
          ))}
          <li className="flex-1">
            <MobileMore groups={groups} labels={labels} isActive={isActive} active={moreActive} />
          </li>
        </ul>
      </nav>
    </>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`inline-flex min-h-[36px] items-center rounded px-3 py-2 text-xs font-medium transition-colors ${
        active ? 'bg-bg-raised text-ink' : 'text-ink-muted hover:bg-bg-raised hover:text-ink'
      }`}
    >
      {children}
    </Link>
  );
}

/** The fifth bottom-bar slot: a sheet holding the grouped secondary links. */
function MobileMore({
  groups,
  labels,
  isActive,
  active,
}: {
  groups: { title: string; links: { href: string; label: string }[] }[];
  labels: NavLabels;
  isActive: (href: string) => boolean;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  /*
   * Sheet focus handling. It is a modal surface, so: Escape closes it, focus
   * moves into it on open, and focus returns to the trigger on close —
   * otherwise a keyboard user who dismisses the sheet is dropped back at the
   * top of the document.
   */
  useEffect(() => {
    if (!open) return;
    sheetRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-label={labels.moreTitle}
        className={`flex min-h-[52px] w-full flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[11px] leading-tight transition-colors ${
          active || open ? 'text-accent' : 'text-ink-muted'
        }`}
      >
        <Icon d={PATHS.more} />
        <span>{labels.more}</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label={labels.toggleNav}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/60"
          />
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label={labels.moreTitle}
            className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-xl border-t border-line-strong bg-bg-raised p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-ink">{labels.moreTitle}</p>
              {/* A scrim you can tap is not a close affordance you can see. */}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                aria-label={labels.close}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded border border-line text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
              >
                <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            {groups.map((g) => (
              <div key={g.title} className="mb-3 last:mb-0">
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-faint">{g.title}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {g.links.map((l) => (
                    <Link
                      key={l.href}
                      href={l.href}
                      onClick={() => setOpen(false)}
                      className={`flex min-h-[44px] items-center rounded border px-3 py-2 text-xs transition-colors ${
                        isActive(l.href)
                          ? 'border-accent/40 bg-accent-dim text-accent'
                          : 'border-line bg-bg-inset text-ink-muted'
                      }`}
                    >
                      {l.label}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
