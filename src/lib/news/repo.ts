import 'server-only';
import { createHash } from 'node:crypto';
import { db } from '@/lib/db/driver';
import { newId, nowMs } from '@/lib/db/repo';

export interface ArticleRow {
  id: string;
  dedupe_key: string;
  headline: string;
  url: string;
  publisher: string;
  feed_id: string;
  published_at_ms: number | null;
  event_at_ms: number | null;
  fetched_at_ms: number;
  summary: string | null;
  category: string | null;
  sentiment: string | null;
  sentiment_src: string | null;
  impact: string | null;
  raw_excerpt: string | null;
}

/**
 * Dedupe key: normalised headline + publisher.
 *
 * Normalisation strips punctuation, case and whitespace so the same story
 * re-published with cosmetic differences collapses to one row. The URL is NOT
 * part of the key, because the same story often appears under several URLs
 * (tracking parameters, syndication).
 */
export function articleDedupeKey(headline: string, publisher: string): string {
  const norm = headline
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(`${publisher.toLowerCase()}|${norm}`).digest('hex').slice(0, 32);
}

export interface NewArticle {
  headline: string;
  url: string;
  publisher: string;
  feedId: string;
  publishedAtMs: number | null;
  summary: string | null;
  rawExcerpt: string | null;
  category: string;
  sentiment: string;
  impact: string;
}

export async function insertArticleIfNew(a: NewArticle): Promise<{ created: boolean; article: ArticleRow }> {
  const d = await db();
  const key = articleDedupeKey(a.headline, a.publisher);
  const existing = await d.get<ArticleRow>('SELECT * FROM news_articles WHERE dedupe_key = ?', [key]);
  if (existing) return { created: false, article: existing };

  const id = newId();
  await d.run(
    `INSERT INTO news_articles
       (id, dedupe_key, headline, url, publisher, feed_id, published_at_ms, event_at_ms, fetched_at_ms,
        summary, category, sentiment, sentiment_src, impact, raw_excerpt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'keyword',?,?)`,
    [
      id,
      key,
      a.headline,
      a.url,
      a.publisher,
      a.feedId,
      a.publishedAtMs,
      // The event date is only known when a source states it separately; the
      // publication date is NOT assumed to be the event date.
      null,
      nowMs(),
      a.summary,
      a.category,
      a.sentiment,
      a.impact,
      a.rawExcerpt,
    ],
  );
  const article = await d.get<ArticleRow>('SELECT * FROM news_articles WHERE id = ?', [id]);
  return { created: true, article: article! };
}

export async function linkArticleToAsset(
  articleId: string,
  assetId: string,
  relevance: number,
  reason: string,
): Promise<void> {
  const d = await db();
  await d.run(
    `INSERT INTO news_asset_impacts (article_id, asset_id, relevance, match_reason)
     VALUES (?,?,?,?)
     ON CONFLICT (article_id, asset_id) DO UPDATE SET relevance = excluded.relevance, match_reason = excluded.match_reason`,
    [articleId, assetId, relevance, reason],
  );
}

export async function listArticles(limit = 50, feedId?: string): Promise<ArticleRow[]> {
  const d = await db();
  return feedId
    ? d.all<ArticleRow>(
        'SELECT * FROM news_articles WHERE feed_id = ? ORDER BY COALESCE(published_at_ms, fetched_at_ms) DESC LIMIT ?',
        [feedId, limit],
      )
    : d.all<ArticleRow>(
        'SELECT * FROM news_articles ORDER BY COALESCE(published_at_ms, fetched_at_ms) DESC LIMIT ?',
        [limit],
      );
}

export async function listArticlesForAsset(assetId: string, limit = 10): Promise<(ArticleRow & { relevance: number; match_reason: string })[]> {
  const d = await db();
  return d.all(
    `SELECT n.*, i.relevance, i.match_reason
     FROM news_asset_impacts i JOIN news_articles n ON n.id = i.article_id
     WHERE i.asset_id = ?
     ORDER BY COALESCE(n.published_at_ms, n.fetched_at_ms) DESC LIMIT ?`,
    [assetId, limit],
  );
}

export async function countArticles(): Promise<number> {
  const d = await db();
  const row = await d.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_articles');
  return Number(row?.n ?? 0);
}
