import { features } from '@/lib/config/env';
import { listProviderStatus } from '@/lib/db/repo';
import { formatAge, formatUtc } from '@/lib/format';
import { listArticles } from '@/lib/news/repo';
import { resolveFeeds } from '@/lib/providers/news/feeds';
import { Card, EmptyState, InfoNote, Stat, WarningNote } from '@/components/ui';
import { getMessages } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

const SENTIMENT_TONE: Record<string, string> = {
  bullish: 'text-up',
  bearish: 'text-down',
  neutral: 'text-ink-muted',
  unclear: 'text-warn',
};

export default async function NewsPage({ searchParams }: { searchParams: Promise<{ feed?: string }> }) {
  const { feed } = await searchParams;
  const t = await getMessages();
  const flags = features();
  const feeds = resolveFeeds();
  const [articles, providers] = await Promise.all([listArticles(80, feed), listProviderStatus()]);
  const newsStatus = providers.filter((p) => p.operation === 'news');

  const highImpact = articles.filter((a) => a.impact === 'high').length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink">{t.news.title}</h1>
        <p className="text-2xs text-ink-muted">{t.news.subtitle}</p>
      </div>

      {!flags.newsEnabled && (
        <WarningNote>{t.news.noFeeds}</WarningNote>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t.news.statStored} value={articles.length} sub={feed ? `feed: ${feed}` : t.news.statStoredAll} />
        <Stat label={t.news.statHigh} value={highImpact} sub={t.news.statHighSub} />
        <Stat label={t.news.statEnabled} value={feeds.filter((f) => f.available).length} sub={t.news.statConfigured(feeds.length)} />
        <Stat label={t.news.statSkipped} value={feeds.filter((f) => !f.available).length} sub={t.news.statSkippedSub} />
      </div>

      <Card title={t.news.feedsTitle} subtitle={t.news.feedsSub}>
        <ul className="space-y-2">
          {feeds.map((f) => {
            const status = newsStatus.find((s) => s.provider === f.feed.id);
            return (
              <li key={f.feed.id} className="rounded border border-line bg-bg-inset px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-ink">{f.feed.name}</span>
                  <span
                    className={`rounded border px-1.5 py-px text-2xs ${
                      f.available ? 'border-up/30 bg-up-dim text-up' : 'border-warn/30 bg-warn-dim text-warn'
                    }`}
                  >
                    {f.available ? t.news.enabled : t.news.skipped}
                  </span>
                  <span className="text-2xs text-ink-faint">{f.feed.publisher}</span>
                </div>
                {f.reason && <p className="mt-1 text-2xs text-warn">{f.reason}</p>}
                {f.feed.notes && <p className="mt-1 text-2xs text-ink-faint">{f.feed.notes}</p>}
                {status && (
                  <p className="mt-1 text-2xs text-ink-faint">
                    {t.news.lastSuccess(formatAge(status.last_ok_ms), status.consecutive_failures)}
                    {status.last_error ? t.news.lastError(status.last_error) : ''}
                  </p>
                )}
              </li>
            );
          })}
          {feeds.length === 0 && <EmptyState title={t.news.noFeedsConfigured} body={t.news.noFeedsConfiguredBody} />}
        </ul>
      </Card>

      <Card title={t.news.articles(articles.length)}>
        {articles.length === 0 ? (
          <EmptyState
            title={t.news.noArticles}
            body={t.news.noArticlesBody}
          />
        ) : (
          <ul className="divide-y divide-line/60">
            {articles.map((a) => (
              <li key={a.id} className="py-2.5">
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="text-sm text-ink hover:text-accent"
                >
                  {a.headline}
                </a>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-faint">
                  <span className="text-ink-muted">{a.publisher}</span>
                  <span>{t.news.published} {formatUtc(a.published_at_ms)}</span>
                  <span>{t.news.retrieved} {formatAge(a.fetched_at_ms)}</span>
                  <span className="rounded border border-line-strong px-1 py-px">{a.category}</span>
                  <span className={SENTIMENT_TONE[a.sentiment ?? 'neutral']}>
                    {a.sentiment} ({a.sentiment_src})
                  </span>
                  <span>{t.news.impact} {a.impact}</span>
                </div>
                {a.summary && <p className="mt-1 line-clamp-2 text-2xs text-ink-muted">{a.summary}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <InfoNote>{t.news.footer}</InfoNote>
    </div>
  );
}
