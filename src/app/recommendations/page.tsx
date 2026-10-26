import Link from 'next/link';
import { TRADING_STYLES } from '@/lib/market/types';
import { recommendCandidates, type CandidateBand } from '@/lib/markets/recommend';
import { getMessages } from '@/lib/i18n';
import { recommendLabels } from '@/lib/i18n/client-labels';
import { Card, Disclaimer, ErrorState, InfoNote, WarningNote } from '@/components/ui';
import { formatUtc } from '@/lib/format';
import { CandidateTable } from './candidate-table';

export const dynamic = 'force-dynamic';

const BANDS: (CandidateBand | 'any')[] = ['any', 'liquid', 'active', 'speculative', 'thin'];
const VENUES = ['all', 'BINANCE', 'INDODAX'] as const;

/**
 * Watchlist candidates.
 *
 * Ranks instruments by MEASURED tradability — 24h turnover and trade count —
 * never by expected return. The disclaimer is not boilerplate: a ranked list
 * on a trading screen reads as a buy list unless it says otherwise, loudly and
 * before the table.
 */
export default async function RecommendationsPage({
  searchParams,
}: {
  searchParams: Promise<{ exchange?: string; band?: string }>;
}) {
  const sp = await searchParams;
  const t = await getMessages();

  const exchange = (VENUES as readonly string[]).includes(sp.exchange ?? 'all')
    ? ((sp.exchange ?? 'all') as 'all' | 'BINANCE' | 'INDODAX')
    : 'all';
  const band = (BANDS as string[]).includes(sp.band ?? 'any')
    ? ((sp.band ?? 'any') as CandidateBand | 'any')
    : 'any';

  const result = await recommendCandidates({ exchange, band, limit: 40 });

  const bandLabel: Record<string, string> = {
    any: t.recommend.anyBand,
    liquid: t.recommend.bandLiquid,
    active: t.recommend.bandActive,
    speculative: t.recommend.bandSpeculative,
    thin: t.recommend.bandThin,
  };
  const bandHelp: Record<string, string> = {
    liquid: t.recommend.bandLiquidHelp,
    active: t.recommend.bandActiveHelp,
    speculative: t.recommend.bandSpeculativeHelp,
    thin: t.recommend.bandThinHelp,
  };

  function href(next: { exchange?: string; band?: string }): string {
    const p = new URLSearchParams();
    const ex = next.exchange ?? exchange;
    const bd = next.band ?? band;
    if (ex !== 'all') p.set('exchange', ex);
    if (bd !== 'any') p.set('band', bd);
    const q = p.toString();
    return q ? `/recommendations?${q}` : '/recommendations';
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink">{t.recommend.title}</h1>
        <p className="mt-0.5 text-2xs text-ink-muted">{t.recommend.subtitle}</p>
      </div>

      {/* Stated before the table, not after it. */}
      <WarningNote>{t.recommend.notAPrediction}</WarningNote>

      <Card title={t.recommend.howScored}>
        <p className="text-2xs leading-relaxed text-ink-muted">{t.recommend.howScoredBody}</p>
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
          {(['liquid', 'active', 'speculative', 'thin'] as const).map((b) => (
            <div key={b} className="rounded border border-line bg-bg-inset px-3 py-2">
              <dt className="text-2xs font-semibold text-ink">{bandLabel[b]}</dt>
              <dd className="mt-0.5 text-2xs text-ink-faint">{bandHelp[b]}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card>
        <div className="flex flex-wrap gap-4">
          <div>
            <p className="mb-1 text-2xs uppercase tracking-wide text-ink-faint">{t.recommend.filterExchange}</p>
            <div className="flex flex-wrap gap-1.5">
              {VENUES.map((v) => (
                <Link
                  key={v}
                  href={href({ exchange: v })}
                  aria-current={exchange === v ? 'true' : undefined}
                  className={`inline-flex min-h-[28px] items-center rounded border px-2.5 py-1 text-2xs transition-colors ${
                    exchange === v
                      ? 'border-accent/40 bg-accent-dim text-accent'
                      : 'border-line bg-bg-inset text-ink-muted hover:text-ink'
                  }`}
                >
                  {v === 'all' ? t.recommend.allVenues : v}
                </Link>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1 text-2xs uppercase tracking-wide text-ink-faint">{t.recommend.filterBand}</p>
            <div className="flex flex-wrap gap-1.5">
              {BANDS.map((b) => (
                <Link
                  key={b}
                  href={href({ band: b })}
                  aria-current={band === b ? 'true' : undefined}
                  className={`inline-flex min-h-[28px] items-center rounded border px-2.5 py-1 text-2xs transition-colors ${
                    band === b
                      ? 'border-accent/40 bg-accent-dim text-accent'
                      : 'border-line bg-bg-inset text-ink-muted hover:text-ink'
                  }`}
                >
                  {bandLabel[b]}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {result.errors.map((e) => (
        <ErrorState key={e.source} title={`${t.recommend.venueError} ${e.source}`} detail={e.error} />
      ))}

      <Card
        title={t.recommend.title}
        subtitle={`${t.recommend.generatedAt} ${formatUtc(result.generatedAtMs)}`}
      >
        <CandidateTable
          candidates={result.candidates}
          excludedFlatCount={result.excludedFlatCount}
          minRangePct={result.minRangePct}
          labels={recommendLabels(t)}
          styles={TRADING_STYLES}
        />
      </Card>

      <InfoNote>{t.recommend.equitiesNote}</InfoNote>
      <Disclaimer text={t.ui.disclaimer} />
    </div>
  );
}
