import 'server-only';
import { httpText } from '../http';
import { htmlToText, sanitizeArticleText, sanitizeUrl } from '@/lib/news/sanitize';
import type { NewsItem, NewsProvider } from '../types';

/**
 * Minimal RSS 2.0 / Atom reader.
 *
 * Deliberately dependency-free: the three default feeds are small, well-formed
 * documents, and a full XML parser would add supply-chain surface for no gain.
 * Anything it cannot parse is skipped rather than guessed at.
 */

export interface FeedDefinition {
  id: string;
  name: string;
  publisher: string;
  url: string;
  /** Extra request headers, e.g. SEC's required contact User-Agent. */
  headers?: Record<string, string>;
  /** Default event category when the feed is topic-specific. */
  category?: string;
  notes?: string;
}

function decodeCdata(value: string): string {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
  return m ? m[1]! : value;
}

function tag(block: string, name: string): string | null {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const m = re.exec(block);
  return m ? decodeCdata(m[1]!).trim() : null;
}

/** Atom links carry the URL in an href attribute rather than as text. */
function atomLink(block: string): string | null {
  const alternate = /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(block);
  if (alternate) return alternate[1]!;
  const any = /<link[^>]*href=["']([^"']+)["']/i.exec(block);
  return any ? any[1]! : null;
}

function parseDate(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function parseFeed(xml: string, feed: FeedDefinition): NewsItem[] {
  const blocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ].map((m) => m[1]!);

  const items: NewsItem[] = [];
  for (const block of blocks) {
    const rawTitle = tag(block, 'title');
    const rawLink = tag(block, 'link') ?? atomLink(block);
    if (!rawTitle || !rawLink) continue;

    const url = sanitizeUrl(rawLink);
    if (!url) continue;

    const published =
      parseDate(tag(block, 'pubDate')) ??
      parseDate(tag(block, 'published')) ??
      parseDate(tag(block, 'updated')) ??
      parseDate(tag(block, 'dc:date'));

    const body = tag(block, 'description') ?? tag(block, 'summary') ?? tag(block, 'content') ?? '';
    const sanitized = sanitizeArticleText(body, 1200);

    items.push({
      headline: htmlToText(rawTitle).slice(0, 400),
      url,
      publisher: feed.publisher,
      feedId: feed.id,
      publishedAtMs: published,
      summary: sanitized.text.slice(0, 600) || null,
      rawExcerpt: sanitized.text || null,
    });
  }
  return items;
}

export class RssNewsProvider implements NewsProvider {
  readonly id: string;
  readonly label: string;

  constructor(private readonly feed: FeedDefinition) {
    this.id = feed.id;
    this.label = feed.name;
  }

  isConfigured(): boolean {
    return true;
  }

  async fetchLatest(limit: number): Promise<NewsItem[]> {
    const xml = await httpText(this.feed.url, {
      headers: this.feed.headers,
      timeoutMs: 20_000,
      maxBytes: 4 * 1024 * 1024,
    });
    return parseFeed(xml, this.feed).slice(0, limit);
  }
}
