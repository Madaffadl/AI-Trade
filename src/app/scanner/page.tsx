import { scanWatchlist } from '@/lib/market/scanner';
import { isTimeframe, TIMEFRAMES, type Timeframe } from '@/lib/market/types';
import { ReasonList, ScanTable } from '@/components/scan-table';
import { FxDisclosure } from '@/components/money';
import { fxContext, getDisplayCurrencySetting } from '@/lib/fx/service';
import { getMessages } from '@/lib/i18n';
import { Card, EmptyState, InfoNote } from '@/components/ui';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

type SortKey = 'symbol' | 'change' | 'volume' | 'trend' | 'volatility' | 'signal';

export default async function ScannerPage({
  searchParams,
}: {
  searchParams: Promise<{ tf?: string; sort?: string; group?: string }>;
}) {
  const params = await searchParams;
  const timeframe: Timeframe | undefined = isTimeframe(params.tf) ? params.tf : undefined;
  const sort = (['symbol', 'change', 'volume', 'trend', 'volatility', 'signal'] as SortKey[]).includes(params.sort as SortKey)
    ? (params.sort as SortKey)
    : 'change';
  const group = params.group === 'crypto' || params.group === 'stock' ? params.group : 'all';

  const t = await getMessages();
  const display = await getDisplayCurrencySetting();
  const fx = await fxContext(display);
  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'symbol', label: t.scanner.sortSymbol },
    { key: 'change', label: t.scanner.sortChange },
    { key: 'volume', label: t.scanner.sortVolume },
    { key: 'trend', label: t.scanner.sortTrend },
    { key: 'volatility', label: t.scanner.sortVolatility },
    { key: 'signal', label: t.scanner.sortSignal },
  ];

  const all = await scanWatchlist({ timeframe });
  const rows = all.filter((r) => group === 'all' || r.assetClass === group);

  const sorted = [...rows].sort((a, b) => {
    const nullsLast = (x: number | null) => (x === null ? -Infinity : x);
    switch (sort) {
      case 'symbol':
        return a.symbol.localeCompare(b.symbol);
      case 'change':
        return nullsLast(b.changePct) - nullsLast(a.changePct);
      case 'volume':
        return nullsLast(b.relativeVolume) - nullsLast(a.relativeVolume);
      case 'volatility':
        return nullsLast(b.atrPct) - nullsLast(a.atrPct);
      case 'trend': {
        const rank = { bullish: 3, neutral: 2, bearish: 1, unknown: 0 } as const;
        return rank[b.trend] - rank[a.trend];
      }
      case 'signal': {
        const rank: Record<string, number> = { BUY: 4, SELL: 3, HOLD: 2, WAIT: 1 };
        return (rank[b.latestSignal?.action ?? ''] ?? 0) - (rank[a.latestSignal?.action ?? ''] ?? 0);
      }
      default:
        return 0;
    }
  });

  const link = (patch: Record<string, string>) => {
    const sp = new URLSearchParams({ sort, group, ...(timeframe ? { tf: timeframe } : {}), ...patch });
    return `/scanner?${sp.toString()}`;
  };

  const bullish = sorted.filter((r) => r.trend === 'bullish').length;
  const bearish = sorted.filter((r) => r.trend === 'bearish').length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink">{t.scanner.title}</h1>
        <p className="text-2xs text-ink-muted">{t.scanner.subtitle(bullish, bearish, sorted.length - bullish - bearish)}</p>
      </div>

      <div className="flex flex-wrap gap-4 rounded border border-line bg-bg-raised px-3 py-2.5">
        <Filter
          label={t.common.market}
          options={[
            { href: link({ group: 'all' }), label: t.common.all, active: group === 'all' },
            { href: link({ group: 'crypto' }), label: t.common.crypto, active: group === 'crypto' },
            { href: link({ group: 'stock' }), label: t.common.stocks, active: group === 'stock' },
          ]}
        />
        <Filter
          label={t.common.sortBy}
          options={sortOptions.map((o) => ({ href: link({ sort: o.key }), label: o.label, active: sort === o.key }))}
        />
        <Filter
          label={t.common.timeframe}
          options={[
            { href: link({ tf: '' }), label: t.scanner.perStyle, active: !timeframe },
            ...TIMEFRAMES.map((tf) => ({ href: link({ tf }), label: tf, active: timeframe === tf })),
          ]}
        />
      </div>

      <Card title={t.scanner.results(sorted.length)} subtitle={t.scanner.resultsSub}>
        {sorted.length === 0 ? (
          <EmptyState title={t.scanner.nothing} body={t.scanner.nothingBody} />
        ) : (
          <ScanTable rows={sorted} fx={fx} t={t} />
        )}
      </Card>

      <Card title={t.scanner.reasonsTitle} subtitle={t.scanner.reasonsSub}>
        {sorted.length === 0 ? (
          <EmptyState title={t.scanner.noReasons} body={t.scanner.noReasonsBody} />
        ) : (
          <ReasonList rows={sorted} t={t} />
        )}
      </Card>

      <FxDisclosure target={display} providerUpdatedAtMs={fx.rates?.providerUpdatedAtMs ?? null} />

      <InfoNote>
        {t.scanner.footer}{' '}
        <Link href="/settings" className="text-accent hover:underline">
          {t.scanner.footerLink}
        </Link>{' '}
        {t.scanner.footerTail}
      </InfoNote>
    </div>
  );
}

function Filter({ label, options }: { label: string; options: { href: string; label: string; active: boolean }[] }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-2xs uppercase tracking-wide text-ink-faint">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <Link
            key={o.href + o.label}
            href={o.href}
            className={`rounded px-2 py-1 text-2xs ${
              o.active ? 'bg-accent-dim text-accent' : 'text-ink-muted hover:bg-bg-inset hover:text-ink'
            }`}
          >
            {o.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
