import type { Metadata, Viewport } from 'next';
import { Nav } from '@/components/nav';
import { HintLayer } from '@/components/hint-layer';
import { Disclaimer } from '@/components/ui';
import { countUnread } from '@/lib/notifications/repo';
import { i18n } from '@/lib/i18n';
import type { Messages } from '@/lib/i18n/en';
import { id } from '@/lib/i18n/id';
import type { Locale } from '@/lib/i18n/types';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Trade — personal trading intelligence',
  description: 'Private market monitoring, deterministic signals and AI-assisted analysis.',
  robots: { index: false, follow: false },
};

/**
 * Explicit viewport. Next supplies a default, but stating it here makes the
 * zoom policy a reviewable decision rather than an inherited one: no
 * `maximumScale`, no `userScalable: false`. Blocking pinch-zoom on a screen
 * full of small numbers would be indefensible.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The alert badge needs the database; if it is not migrated yet the shell
  // still renders rather than failing the whole page.
  let unread = 0;
  let locale: Locale = 'id';
  let t: Messages = id;
  try {
    unread = await countUnread();
    const loaded = await i18n();
    locale = loaded.locale;
    t = loaded.t;
  } catch {
    // The shell must still render before the database is migrated.
  }

  return (
    <html lang={locale} className="dark">
      <body className="min-h-screen bg-bg">
        {/*
          Skip link. First thing in the tab order, visually hidden until
          focused. Without it, reaching page content by keyboard means tabbing
          past the whole navigation on every single route.
        */}
        <a href="#main" className="skip-link">
          {t.nav.skipToContent}
        </a>
        <HintLayer />
        <Nav unreadCount={unread} locale={locale} labels={t.nav} />
        {/*
          `pb-20 lg:pb-0` clears the fixed mobile bottom bar. Scroll content
          hidden behind a fixed bar is the classic version of this bug, and it
          always bites the last row of the longest table.
        */}
        <main id="main" tabIndex={-1} className="mx-auto max-w-[1400px] px-4 py-5">
          {children}
        </main>
        <footer className="mx-auto max-w-[1400px] border-t border-line px-4 py-5 pb-20 lg:pb-5">
          <Disclaimer text={t.ui.disclaimer} />
        </footer>
      </body>
    </html>
  );
}
