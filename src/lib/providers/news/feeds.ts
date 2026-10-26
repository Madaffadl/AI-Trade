import 'server-only';
import { env } from '@/lib/config/env';
import type { FeedDefinition } from './rss';
import { RssNewsProvider } from './rss';

/**
 * Built-in news feeds.
 *
 * All three were verified reachable on 2026-10-22. They are official or
 * reputable sources published as RSS/Atom, which keeps news ingestion free and
 * key-less. Additional feeds can be added through NEWS_EXTRA_FEEDS without code
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
    id: 'sec_8k',
    name: 'SEC EDGAR - recent 8-K filings',
    publisher: 'U.S. Securities and Exchange Commission',
    // Company-agnostic feed of recent 8-K current reports.
    url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=8-K&dateb=&owner=include&count=40&output=atom',
    category: 'corporate_action',
    notes:
      'SEC requires a declaring User-Agent with contact details. Without SEC_USER_AGENT this feed is skipped rather than requested anonymously (which returns HTTP 403).',
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

  return selected.map((feed) => {
    if (feed.id === 'sec_8k' && !e.SEC_USER_AGENT) {
      return {
        feed,
        available: false,
        reason:
          'SEC_USER_AGENT is not set. The SEC requires a User-Agent with contact details and returns HTTP 403 without one.',
      };
    }
    return { feed, available: true, reason: null };
  });
}

export function newsProviders(): RssNewsProvider[] {
  return resolveFeeds()
    .filter((f) => f.available)
    .map((f) => {
      const feed = { ...f.feed };
      if (feed.id === 'sec_8k') {
        feed.headers = { 'User-Agent': env().SEC_USER_AGENT };
      }
      return new RssNewsProvider(feed);
    });
}
