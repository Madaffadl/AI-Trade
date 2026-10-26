import Link from 'next/link';
import { listAssets } from '@/lib/db/repo';
import { convertForDisplay, fxContext, getDisplayCurrencySetting } from '@/lib/fx/service';
import { formatAge, formatCompact, formatPercentSigned } from '@/lib/format';
import { CAP_BANDS, catalogStats, queryCatalog, type CapTier } from '@/lib/markets/catalog';
import { Card, EmptyState, InfoNote, Stat, Table, WarningNote } from '@/components/ui';
import { FxDisclosure, Money } from '@/components/money';
import { HeadHint, HintMark } from '@/components/hint';
import { getLocale, getMessages } from '@/lib/i18n';
import { INTL_LOCALE } from '@/lib/i18n/types';
import { AddToWatchlistButton, SyncCatalogButton } from './catalog-actions';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 75;

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; class?: string; ex?: string; cap?: string; sort?: string; page?: string }>;
}) {
  const t = await getMessages();
  const sp = await searchParams;
  const assetClass = sp.class === 'crypto' || sp.class === 'stock' ? sp.class : undefined;
  const capLabel: Record<CapTier, string> = {
    any: t.markets.capAny,
    mega: `Mega ${CAP_BANDS.mega.label}`,
    large: `Large ${CAP_BANDS.large.label}`,
    mid: `Mid ${CAP_BANDS.mid.label}`,
    small: `Small ${CAP_BANDS.small.label}`,
    micro: `Micro ${CAP_BANDS.micro.label}`,
    unknown: t.markets.capUnknown,
  };
  const capTier = (Object.keys(capLabel) as CapTier[]).includes(sp.cap as CapTier) ? (sp.cap as CapTier) : 'any';
  const sort = sp.sort === 'market_cap' || sp.sort === 'change' ? sp.sort : 'symbol';
  const page = Math.max(1, Number(sp.page ?? '1') || 1);

  const [stats, display, tracked] = await Promise.all([catalogStats(), getDisplayCurrencySetting(), listAssets()]);
  const intlLocale = INTL_LOCALE[await getLocale()];
  const fx = await fxContext(display);

  const { rows, total } = await queryCatalog({
    assetClass,
    exchangeId: sp.ex,
    search: sp.q,
    capTier,
    sort,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const trackedKeys = new Set(tracked.map((a) => `${a.exchangeId}:${a.symbol}`));
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const link = (patch: Record<string, string>) => {
    const next = new URLSearchParams();
    const base: Record<string, string | undefined> = {
      q: sp.q,
      class: assetClass,
      ex: sp.ex,
      cap: capTier === 'any' ? undefined : capTier,
      sort: sort === 'symbol' ? undefined : sort,
      ...patch,
    };
    for (const [k, v] of Object.entries(base)) if (v) next.set(k, v);
    return `/markets?${next.toString()}`;
  };

  const exchanges = stats.byExchange.map((b) => b.exchange_id);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t.markets.title}</h1>
          <p className="text-2xs text-ink-muted">{t.markets.subtitle}</p>
        </div>
        <SyncCatalogButton label={t.markets.syncButton(stats.total.toLocaleString(intlLocale))} busyLabel={t.markets.syncing} />
      </div>

      {stats.total === 0 ? (
        <EmptyState
          title={t.markets.emptyTitle}
          body={t.markets.emptyBody}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t.markets.statTotal} value={stats.total.toLocaleString(intlLocale)} />
            {stats.byExchange.slice(0, 3).map((b) => (
              <Stat
                key={`${b.exchange_id}-${b.asset_class}`}
                label={b.exchange_id}
                value={b.n.toLocaleString(intlLocale)}
                sub={`${b.asset_class} · ${formatAge(b.fetched_at_ms)}`}
              />
            ))}
          </div>

          <form method="GET" action="/markets" className="flex flex-wrap items-end gap-2 rounded border border-line bg-bg-raised px-3 py-2.5">
            <div className="min-w-[180px] flex-1">
              <label className="block text-2xs text-ink-faint">{t.markets.searchLabel}</label>
              <input
                name="q"
                defaultValue={sp.q ?? ''}
                placeholder={t.markets.searchPlaceholder}
                className="mt-1 w-full rounded border border-line bg-bg-inset px-2 py-1.5 min-h-[44px] text-xs text-ink focus:border-accent"
              />
            </div>
            <div>
              <label className="block text-2xs text-ink-faint">{t.markets.typeLabel}</label>
              <select name="class" defaultValue={assetClass ?? ''} className="mt-1 rounded border border-line bg-bg-inset px-2 py-1.5 text-xs text-ink">
                <option value="">{t.common.all}</option>
                <option value="crypto">{t.common.crypto}</option>
                <option value="stock">{t.common.stocks}</option>
              </select>
            </div>
            <div>
              <label className="block text-2xs text-ink-faint">{t.markets.exchangeLabel}</label>
              <select name="ex" defaultValue={sp.ex ?? ''} className="mt-1 rounded border border-line bg-bg-inset px-2 py-1.5 text-xs text-ink">
                <option value="">{t.common.all}</option>
                {exchanges.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-2xs text-ink-faint">
                {t.markets.capLabel}
                <HintMark text={t.glossary.marketCap} />
              </label>
              <select name="cap" defaultValue={capTier} className="mt-1 rounded border border-line bg-bg-inset px-2 py-1.5 text-xs text-ink">
                {(Object.keys(capLabel) as CapTier[]).map((tier) => (
                  <option key={tier} value={tier}>
                    {capLabel[tier]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-2xs text-ink-faint">{t.common.sortBy}</label>
              <select name="sort" defaultValue={sort} className="mt-1 rounded border border-line bg-bg-inset px-2 py-1.5 text-xs text-ink">
                <option value="symbol">{t.common.symbol}</option>
                <option value="market_cap">{t.markets.sortCap}</option>
                <option value="change">{t.markets.sortChange}</option>
              </select>
            </div>
            <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg">
              {t.common.apply}
            </button>
          </form>

          {(capTier === 'micro' || capTier === 'small') && (
            <WarningNote>
              {t.markets.smallCapWarning}
            </WarningNote>
          )}

          <Card
            title={t.markets.resultsTitle(total.toLocaleString(intlLocale))}
            subtitle={t.markets.resultsSub(page, pages.toLocaleString(intlLocale))}
          >
            {rows.length === 0 ? (
              <EmptyState title={t.markets.noMatch} body={t.markets.noMatchBody} />
            ) : (
              <Table
                head={[
                  t.common.symbol,
                  t.common.name,
                  t.common.exchange,
                  t.markets.typeLabel,
                  <HeadHint key="ref" label={t.markets.refPrice} text={t.glossary.refPrice} />,
                  t.common.change,
                  <HeadHint key="cap" label={t.markets.marketCap} text={t.glossary.marketCap} />,
                  <HeadHint key="min" label={t.markets.minOrder} text={t.glossary.minOrder} />,
                  '',
                ]}
              >
                {rows.map((r) => {
                  const key = `${r.exchange_id}:${r.symbol}`;
                  return (
                    <tr key={key} className="hover:bg-bg-inset/60">
                      <td className="px-2 py-2">
                        <Link
                          href={`/markets/${encodeURIComponent(r.exchange_id)}/${encodeURIComponent(r.symbol)}`}
                          className="font-medium text-ink hover:text-accent hover:underline"
                        >
                          {r.symbol}
                        </Link>
                      </td>
                      <td className="max-w-[260px] truncate px-2 py-2 text-2xs" title={r.display_name}>
                        <Link
                          href={`/markets/${encodeURIComponent(r.exchange_id)}/${encodeURIComponent(r.symbol)}`}
                          className="text-ink-muted hover:text-accent"
                        >
                          {r.display_name}
                        </Link>
                      </td>
                      <td className="px-2 py-2 text-2xs text-ink-muted">{r.exchange_id}</td>
                      <td className="px-2 py-2 text-2xs text-ink-faint">{r.asset_class}</td>
                      <td className="px-2 py-2 text-ink-muted">
                        <Money money={convertForDisplay(r.last_price, r.currency, fx)} />
                      </td>
                      <td className={`num px-2 py-2 ${(r.change_pct ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>
                        {r.change_pct === null ? <span className="text-ink-faint">—</span> : formatPercentSigned(r.change_pct)}
                      </td>
                      <td className="num px-2 py-2 text-ink-muted">
                        {r.market_cap === null ? <span className="text-ink-faint">—</span> : `$${formatCompact(r.market_cap)}`}
                      </td>
                      <td className="num px-2 py-2 text-2xs text-ink-faint">
                        {r.min_notional !== null ? `${formatCompact(r.min_notional)} ${r.currency}` : r.lot_size !== null ? `${r.lot_size}` : '—'}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <AddToWatchlistButton
                          symbol={r.symbol}
                          displayName={r.display_name}
                          exchangeId={r.exchange_id}
                          assetClass={r.asset_class}
                          currency={r.currency}
                          alreadyTracked={trackedKeys.has(key)}
                          labels={{ track: t.markets.track, tracked: t.markets.tracked }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )}

            {pages > 1 && (
              <div className="mt-3 flex items-center justify-between">
                <Link
                  href={link({ page: String(Math.max(1, page - 1)) })}
                  className={`rounded border border-line px-2 py-1 text-2xs ${page <= 1 ? 'pointer-events-none text-ink-faint opacity-40' : 'text-ink-muted hover:text-ink'}`}
                >
                  ← {t.common.previous}
                </Link>
                <span className="text-2xs text-ink-faint">
                  {page} / {pages.toLocaleString(intlLocale)}
                </span>
                <Link
                  href={link({ page: String(Math.min(pages, page + 1)) })}
                  className={`rounded border border-line px-2 py-1 text-2xs ${page >= pages ? 'pointer-events-none text-ink-faint opacity-40' : 'text-ink-muted hover:text-ink'}`}
                >
                  {t.common.next} →
                </Link>
              </div>
            )}
          </Card>
        </>
      )}

      <FxDisclosure target={display} providerUpdatedAtMs={fx.rates?.providerUpdatedAtMs ?? null} />

      <InfoNote>
        {t.markets.footer}
      </InfoNote>
    </div>
  );
}
