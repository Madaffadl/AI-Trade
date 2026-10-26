'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { fill, type RecommendLabels } from '@/lib/i18n/client-labels';

export interface CandidateView {
  exchangeId: string;
  symbol: string;
  displayName: string;
  quoteCurrency: string;
  quoteVolume24h: number;
  rangePct24h: number;
  changePct24h: number;
  tradeCount24h: number | null;
  band: string;
  tradabilityScore: number;
  reasons: string[];
  alreadyTracked: boolean;
}

const BAND_TONE: Record<string, string> = {
  liquid: 'border-up/40 bg-up-dim text-up',
  active: 'border-accent/40 bg-accent-dim text-accent',
  speculative: 'border-warn/40 bg-warn-dim text-warn',
  thin: 'border-line-strong bg-bg-inset text-ink-faint',
};

/** Compact money, in the instrument's own quote currency. Never converted. */
function compactVolume(value: number, currency: string): string {
  const abs = Math.abs(value);
  const unit = abs >= 1e12 ? ['T', 1e12] : abs >= 1e9 ? ['B', 1e9] : abs >= 1e6 ? ['M', 1e6] : abs >= 1e3 ? ['K', 1e3] : ['', 1];
  const n = value / (unit[1] as number);
  return `${n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 1 })}${unit[0]} ${currency}`;
}

function glyph(v: number): string {
  return v > 0 ? '▲' : v < 0 ? '▼' : '◆';
}

export function CandidateTable({
  candidates,
  excludedFlatCount,
  minRangePct,
  labels,
  styles,
}: {
  candidates: CandidateView[];
  excludedFlatCount: number;
  minRangePct: number;
  labels: RecommendLabels;
  styles: readonly string[];
}) {
  const router = useRouter();
  const [style, setStyle] = useState<string>('swing');
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, 'ok' | string>>({});

  async function track(c: CandidateView) {
    const key = `${c.exchangeId}:${c.symbol}`;
    setBusy(key);
    try {
      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: c.symbol,
          displayName: c.displayName,
          assetClass: 'crypto',
          exchangeId: c.exchangeId,
          currency: c.quoteCurrency,
          tradingStyle: style,
        }),
      });
      const body = (await res.json()) as { error?: string };
      setDone((d) => ({ ...d, [key]: res.ok ? 'ok' : (body.error ?? labels.addFailed) }));
      if (res.ok) router.refresh();
    } catch (err) {
      setDone((d) => ({ ...d, [key]: err instanceof Error ? err.message : labels.addFailed }));
    } finally {
      setBusy(null);
    }
  }

  const reasonLabel: Record<string, string> = {
    deepLiquidity: labels.reasonDeepLiquidity,
    tradeableLiquidity: labels.reasonTradeableLiquidity,
    thinLiquidity: labels.reasonThinLiquidity,
    manyTrades: labels.reasonManyTrades,
    tradeCountUnavailable: labels.reasonTradeCountUnavailable,
    wideRange: labels.reasonWideRange,
    moderateRange: labels.reasonModerateRange,
    narrowRange: labels.reasonNarrowRange,
    alreadyTracked: labels.reasonAlreadyTracked,
  };
  const bandLabel: Record<string, string> = {
    liquid: labels.bandLiquid,
    active: labels.bandActive,
    speculative: labels.bandSpeculative,
    thin: labels.bandThin,
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="text-2xs text-ink-muted">
          {labels.tradingStyle}
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            className="mt-1 block min-h-[44px] rounded border border-line bg-bg-inset px-2 py-1.5 text-xs text-ink focus:border-accent"
          >
            {styles.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {excludedFlatCount > 0 && (
          <p className="text-2xs text-ink-faint">
            {fill(labels.excludedFlatTemplate, { count: String(excludedFlatCount), min: String(minRangePct) })}
          </p>
        )}
      </div>

      {candidates.length === 0 ? (
        <p className="text-2xs text-ink-faint">{labels.empty}</p>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4" tabIndex={0} role="region" aria-label={labels.colSymbol}>
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wide text-ink-faint">
                <th scope="col" className="border-b border-line bg-bg-raised px-2 py-2 font-medium">{labels.colSymbol}</th>
                <th scope="col" title={labels.scoreHelp} className="border-b border-line bg-bg-raised px-2 py-2 font-medium">{labels.colScore}</th>
                <th scope="col" title={labels.volumeHelp} className="border-b border-line bg-bg-raised px-2 py-2 font-medium">{labels.colVolume}</th>
                <th scope="col" title={labels.rangeHelp} className="border-b border-line bg-bg-raised px-2 py-2 font-medium">{labels.colRange}</th>
                <th scope="col" className="border-b border-line bg-bg-raised px-2 py-2 font-medium">{labels.colChange}</th>
                <th scope="col" title={labels.tradesHelp} className="border-b border-line bg-bg-raised px-2 py-2 font-medium">{labels.colTrades}</th>
                <th scope="col" className="border-b border-line bg-bg-raised px-2 py-2 font-medium">{labels.colBand}</th>
                <th scope="col" className="border-b border-line bg-bg-raised px-2 py-2 font-medium">{labels.colWhy}</th>
                <th scope="col" className="border-b border-line bg-bg-raised px-2 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {candidates.map((c) => {
                const key = `${c.exchangeId}:${c.symbol}`;
                const state = done[key];
                return (
                  <tr key={key} className="hover:bg-bg-inset/60">
                    <td className="px-2 py-2">
                      <span className="font-medium text-ink">{c.symbol}</span>
                      <span className="ml-1.5 text-2xs text-ink-faint">{c.exchangeId}</span>
                      <p className="truncate text-2xs text-ink-faint">{c.displayName}</p>
                    </td>
                    <td className="num whitespace-nowrap px-2 py-2 text-ink">{c.tradabilityScore.toFixed(3)}</td>
                    <td className="num whitespace-nowrap px-2 py-2 text-ink-muted">
                      {compactVolume(c.quoteVolume24h, c.quoteCurrency)}
                    </td>
                    <td className="num whitespace-nowrap px-2 py-2 text-ink-muted">{c.rangePct24h.toFixed(2)}%</td>
                    <td
                      className={`num whitespace-nowrap px-2 py-2 ${
                        c.changePct24h > 0 ? 'text-up' : c.changePct24h < 0 ? 'text-down' : 'text-flat'
                      }`}
                    >
                      {glyph(c.changePct24h)} {c.changePct24h > 0 ? '+' : ''}
                      {c.changePct24h.toFixed(2)}%
                    </td>
                    <td className="num whitespace-nowrap px-2 py-2 text-ink-muted">
                      {c.tradeCount24h === null ? '—' : c.tradeCount24h.toLocaleString('en-US')}
                    </td>
                    <td className="px-2 py-2">
                      <span
                        className={`inline-flex items-center rounded border px-1.5 py-0.5 text-2xs font-semibold ${
                          BAND_TONE[c.band] ?? BAND_TONE.thin
                        }`}
                      >
                        {bandLabel[c.band] ?? c.band}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <ul className="space-y-0.5">
                        {c.reasons.map((r) => (
                          <li key={r} className="text-2xs text-ink-faint">
                            · {reasonLabel[r] ?? r}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2">
                      {c.alreadyTracked || state === 'ok' ? (
                        <span className="text-2xs text-ink-faint">
                          {state === 'ok' ? labels.added : labels.tracked}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => track(c)}
                          disabled={busy === key}
                          className="inline-flex min-h-[28px] items-center rounded border border-accent/40 bg-accent-dim px-2 py-1 text-2xs font-medium text-accent transition-colors hover:border-accent disabled:opacity-50"
                        >
                          {busy === key ? labels.tracking : labels.track}
                        </button>
                      )}
                      {state && state !== 'ok' && <p className="mt-1 text-2xs text-down">{state}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
