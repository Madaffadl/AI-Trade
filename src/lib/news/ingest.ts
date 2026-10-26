import 'server-only';
import { finishJob, listAssets, recordProviderError, recordProviderOk, startJob } from '@/lib/db/repo';
import { newsProviders, resolveFeeds } from '@/lib/providers/news/feeds';
import { ProviderError } from '@/lib/providers/http';
import { dispatchAlert } from '@/lib/notifications/dispatch';
import { classifyArticle, matchAssets } from './classify';
import { insertArticleIfNew, linkArticleToAsset } from './repo';

export interface IngestSummary {
  feedsAttempted: number;
  feedsSucceeded: number;
  articlesSeen: number;
  articlesNew: number;
  linksCreated: number;
  alertsCreated: number;
  skippedFeeds: { feedId: string; reason: string }[];
  errors: { feedId: string; error: string }[];
}

/**
 * Pull configured news feeds, deduplicate, classify deterministically, and
 * link articles to watchlist assets.
 *
 * If no feed is configured or every feed fails, the rest of the platform is
 * unaffected: this function records the failure and returns. It never invents
 * an article.
 */
export async function ingestNews(limitPerFeed = 25): Promise<IngestSummary> {
  const jobId = await startJob('news_ingest');
  const summary: IngestSummary = {
    feedsAttempted: 0,
    feedsSucceeded: 0,
    articlesSeen: 0,
    articlesNew: 0,
    linksCreated: 0,
    alertsCreated: 0,
    skippedFeeds: [],
    errors: [],
  };

  try {
    for (const f of resolveFeeds()) {
      if (!f.available) summary.skippedFeeds.push({ feedId: f.feed.id, reason: f.reason ?? 'unavailable' });
    }

    const assets = await listAssets();
    const providers = newsProviders();

    for (const provider of providers) {
      summary.feedsAttempted++;
      try {
        const items = await provider.fetchLatest(limitPerFeed);
        await recordProviderOk(provider.id, 'news');
        summary.feedsSucceeded++;
        summary.articlesSeen += items.length;

        for (const item of items) {
          const classification = classifyArticle(item.headline, item.rawExcerpt);
          const { created, article } = await insertArticleIfNew({
            headline: item.headline,
            url: item.url,
            publisher: item.publisher,
            feedId: item.feedId,
            publishedAtMs: item.publishedAtMs,
            summary: item.summary,
            rawExcerpt: item.rawExcerpt,
            category: classification.category,
            sentiment: classification.sentiment,
            impact: classification.impact,
          });
          if (!created) continue;
          summary.articlesNew++;

          const matches = matchAssets(item.headline, item.rawExcerpt, assets);
          for (const m of matches) {
            await linkArticleToAsset(article.id, m.assetId, m.relevance, m.reason);
            summary.linksCreated++;
          }

          // Only high-impact news that touches a tracked asset is alert-worthy.
          if (classification.impact === 'high' && matches.length > 0) {
            const sent = await dispatchAlert({
              dedupeKey: `news:${article.dedupe_key}`,
              kind: 'news',
              severity: 'info',
              title: `Market-moving news: ${item.headline.slice(0, 120)}`,
              body: `${item.publisher} - category ${classification.category}, keyword sentiment ${classification.sentiment}.\n${item.url}\n\nThis is a keyword classification of a headline, not a trading recommendation.`,
              articleId: article.id,
              assetId: matches[0]!.assetId,
            });
            if (sent.created) summary.alertsCreated++;
          }
        }
      } catch (err) {
        const pe = err instanceof ProviderError ? err : new ProviderError(String(err), 'network');
        await recordProviderError(provider.id, 'news', pe.message);
        summary.errors.push({ feedId: provider.id, error: pe.message });
      }
    }

    await finishJob(jobId, summary.errors.length === 0 ? 'ok' : 'partial', summary);
    return summary;
  } catch (err) {
    await finishJob(jobId, 'error', summary, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
