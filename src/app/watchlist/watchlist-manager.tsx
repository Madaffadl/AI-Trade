'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TRADING_STYLES } from '@/lib/market/types';
import { fill, type WatchlistFormLabels } from '@/lib/i18n/client-labels';

interface SearchResult {
  symbol: string;
  displayName: string;
  exchangeId: string;
  assetClass: 'crypto' | 'stock';
  currency: string;
}

export function WatchlistManager({ t }: { t: WatchlistFormLabels }) {
  const router = useRouter();
  const [assetClass, setAssetClass] = useState<'crypto' | 'stock'>('crypto');
  const [query, setQuery] = useState('');
  const [style, setStyle] = useState<string>('swing');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    setErrors([]);
    try {
      const res = await fetch(`/api/assets/search?q=${encodeURIComponent(query)}&assetClass=${assetClass}`);
      const body = (await res.json()) as {
        results?: SearchResult[];
        errors?: { provider: string; error: string }[];
        // Not an error: a provider that is simply not configured. Previously
        // this was swallowed, so "no API key" looked like "no such symbol".
        notices?: { provider: string; notice: string }[];
        error?: string;
      };
      if (!res.ok) {
        setErrors([body.error ?? t.addFailed]);
        setResults([]);
      } else {
        setResults(body.results ?? []);
        setErrors([
          ...(body.errors ?? []).map((x) => `${x.provider}: ${x.error}`),
          ...(body.notices ?? []).map((x) => `${x.provider}: ${x.notice}`),
        ]);
        if ((body.results ?? []).length === 0) setStatus(t.noResults);
      }
    } catch {
      setErrors([t.networkError]);
    } finally {
      setBusy(false);
    }
  }

  async function add(result: SearchResult) {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...result, tradingStyle: style }),
      });
      const body = (await res.json()) as { error?: string };
      if (res.ok) {
        setStatus(fill(t.addedTemplate, { symbol: result.symbol }));
        router.refresh();
      } else {
        setStatus(body.error ?? t.addFailed);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={search} className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-2xs text-ink-faint">{t.market}</label>
          <select
            value={assetClass}
            onChange={(e) => setAssetClass(e.target.value as 'crypto' | 'stock')}
            className="mt-1 rounded border border-line bg-bg-inset px-2 py-1.5 text-xs text-ink"
          >
            <option value="crypto">{t.crypto}</option>
            <option value="stock">{t.stocks}</option>
          </select>
        </div>
        <div className="min-w-[180px] flex-1">
          <label className="block text-2xs text-ink-faint">{t.searchSymbol}</label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={assetClass === 'crypto' ? 'BTC, ETHUSDT…' : 'AAPL, BBCA…'}
            className="mt-1 w-full rounded border border-line bg-bg-inset px-2 py-1.5 min-h-[44px] text-xs text-ink focus:border-accent"
          />
        </div>
        <div>
          <label className="block text-2xs text-ink-faint">{t.tradingStyle}</label>
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            className="mt-1 rounded border border-line bg-bg-inset px-2 py-1.5 text-xs text-ink"
          >
            {TRADING_STYLES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={busy || query.trim().length === 0}
          className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50"
        >
          {busy ? t.searching : t.search}
        </button>
      </form>

      {status && <p className="text-2xs text-ink-muted">{status}</p>}
      {errors.map((e, i) => (
        <p key={i} className="text-2xs text-warn">
          {e}
        </p>
      ))}

      {results.length > 0 && (
        <ul className="max-h-64 space-y-1 overflow-y-auto rounded border border-line bg-bg-inset p-2">
          {results.map((r) => (
            <li key={`${r.exchangeId}-${r.symbol}`} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-bg-raised">
              <span className="num text-xs text-ink">{r.symbol}</span>
              <span className="truncate text-2xs text-ink-faint">{r.displayName} · {r.exchangeId} · {r.currency}</span>
              <button
                onClick={() => add(r)}
                disabled={busy}
                className="ml-auto rounded border border-line-strong px-2 py-0.5 text-2xs text-ink-muted hover:text-ink disabled:opacity-50"
              >
                {t.add}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RemoveButton({
  assetId,
  symbol,
  t,
}: {
  assetId: string;
  symbol: string;
  t: WatchlistFormLabels;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!confirm(fill(t.confirmRemoveTemplate, { symbol }))) return;
    setBusy(true);
    try {
      await fetch('/api/watchlist', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button onClick={remove} disabled={busy} className="text-2xs text-ink-faint hover:text-down disabled:opacity-50">
      {busy ? '…' : t.remove}
    </button>
  );
}
