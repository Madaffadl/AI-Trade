import 'server-only';
import { env } from '@/lib/config/env';
import type { FeedDefinition } from './rss';
import { RssNewsProvider } from './rss';

/**
 * Built-in news feeds.
 *
 * Crypto news and the central-bank decisions that move it, both verified
 * reachable on 2026-10-22, published as RSS/Atom - free and key-less. (The US
 * SEC filings feed was removed with the stock markets on 2026-10-29.) Additional feeds can be added through NEWS_EXTRA_FEEDS without code
 * changes.
 */
export const BUILTIN_FEEDS: FeedDefinition[] = [
  {
    id: 'fed_monetary',
    name: 'Federal Reserve - Monetary Policy press releases',
    publisher: 'Board of Governors of the Federal Reserve System',
    url: 'https://www.federalreserve.gov/feeds/press_monetary.xml',
    category: 'monetary_policy',
    notes: 'Primary source for FOMC statements and rate decisions. Verified reachable 2026-10-22.',
  },
  {
    id: 'coindesk',
    name: 'CoinDesk',
    publisher: 'CoinDesk',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    category: 'crypto',
    notes: 'Reputable crypto media. Verified reachable 2026-10-22 (requires following a 308 redirect).',
  },
];

/** Parse NEWS_EXTRA_FEEDS: "id|name|url" entries separated by ";". */
export function extraFeeds(): FeedDefinition[] {
  const raw = env().NEWS_EXTRA_FEEDS;
  if (!raw) return [];
  const out: FeedDefinition[] = [];
  for (const entry of raw.split(';')) {
    const [id, name, url] = entry.split('|').map((s) => s?.trim());
    if (!id || !name || !url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
    } catch {
      continue;
    }
    out.push({ id, name, publisher: name, url, notes: 'Configured via NEWS_EXTRA_FEEDS.' });
  }
  return out;
}

export interface FeedAvailability {
  feed: FeedDefinition;
  available: boolean;
  reason: string | null;
}

/** Feeds the current configuration enables, with the reason for any exclusion. */
export function resolveFeeds(): FeedAvailability[] {
  const e = env();
  const selected = e.NEWS_FEEDS.includes('all')
    ? [...BUILTIN_FEEDS, ...extraFeeds()]
    : [...BUILTIN_FEEDS, ...extraFeeds()].filter((f) => e.NEWS_FEEDS.includes(f.id));

  return selected.map((feed) => ({ feed, available: true, reason: null }));
}

export function newsProviders(): RssNewsProvider[] {
  return resolveFeeds()
    .filter((f) => f.available)
    .map((f) => new RssNewsProvider(f.feed));
}
