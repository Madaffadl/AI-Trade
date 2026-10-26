import Link from 'next/link';
import { ensureDefaultWatchlist, listWatchlist } from '@/lib/db/repo';
import { scanWatchlist } from '@/lib/market/scanner';
import { Card, DataQualityBadge, EmptyState, InfoNote, Table } from '@/components/ui';
import { formatAge, formatPrice } from '@/lib/format';
import { RemoveButton, WatchlistManager } from './watchlist-manager';
import { getMessages } from '@/lib/i18n';
import { watchlistFormLabels, type WatchlistFormLabels } from '@/lib/i18n/client-labels';
import type { Messages } from '@/lib/i18n/en';

export const dynamic = 'force-dynamic';

export default async function WatchlistPage() {
  const t = await getMessages();
  const formLabels = watchlistFormLabels(t);
  const watchlistId = await ensureDefaultWatchlist();
  const [entries, rows] = await Promise.all([listWatchlist(watchlistId), scanWatchlist()]);

  const crypto = entries.filter((e) => e.assetClass === 'crypto');
  const stocks = entries.filter((e) => e.assetClass === 'stock');
  const byId = new Map(rows.map((r) => [r.assetId, r]));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink">{t.watchlist.title}</h1>
        <p className="text-2xs text-ink-muted">{t.watchlist.subtitle}</p>
      </div>

      <Card title={t.watchlist.addTitle} subtitle={t.watchlist.addSub}>
        <WatchlistManager t={formLabels} />
      </Card>

      <Group title={t.watchlist.crypto} entries={crypto} byId={byId} t={t} formLabels={formLabels} />
      <Group title={t.watchlist.stocks} entries={stocks} byId={byId} t={t} formLabels={formLabels} />

      <InfoNote>{t.watchlist.footer}</InfoNote>
    </div>
  );
}

function Group({
  title,
  entries,
  byId,
  t,
  formLabels,
}: {
  title: string;
  entries: Awaited<ReturnType<typeof listWatchlist>>;
  byId: Map<string, Awaited<ReturnType<typeof scanWatchlist>>[number]>;
  t: Messages;
  formLabels: WatchlistFormLabels;
}) {
  return (
    <Card title={t.watchlist.group(title, entries.length)}>
      {entries.length === 0 ? (
        <EmptyState title={t.watchlist.emptyGroup(title)} body={t.watchlist.emptyGroupBody} />
      ) : (
        <Table
          head={[
            t.common.symbol,
            t.common.name,
            t.common.exchange,
            t.watchlist.style,
            t.common.timeframe,
            t.watchlist.lastPrice,
            t.common.data,
            t.common.updated,
            '',
          ]}
        >
          {entries.map((e) => {
            const row = byId.get(e.id);
            return (
              <tr key={e.id} className="hover:bg-bg-inset/60">
                <td className="px-2 py-2">
                  <Link href={`/assets/${e.id}`} className="font-medium text-ink hover:text-accent">
                    {e.symbol}
                  </Link>
                </td>
                <td className="truncate px-2 py-2 text-2xs text-ink-muted">{e.displayName}</td>
                <td className="px-2 py-2 text-2xs text-ink-muted">{e.exchangeId}</td>
                <td className="px-2 py-2 text-2xs text-ink-muted">{e.tradingStyle}</td>
                <td className="px-2 py-2 text-2xs text-ink-muted">{row?.timeframe ?? '—'}</td>
                <td className="num px-2 py-2 text-ink">{formatPrice(row?.price ?? null, e.currency)}</td>
                <td className="px-2 py-2">{row ? <DataQualityBadge quality={row.quality} labels={t.quality} /> : '—'}</td>
                <td className="px-2 py-2 text-2xs text-ink-faint">{formatAge(row?.fetchedAtMs ?? null)}</td>
                <td className="px-2 py-2 text-right">
                  <RemoveButton assetId={e.id} symbol={e.symbol} t={formLabels} />
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </Card>
  );
}
