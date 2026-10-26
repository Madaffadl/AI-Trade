'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TRADING_STYLES } from '@/lib/market/types';

/** Pull fresh reference data from every provider. */
export function SyncCatalogButton({
  label,
  busyLabel,
}: {
  label: string;
  busyLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/markets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync' }),
      });
      const body = (await res.json()) as { results?: { source: string; inserted: number; error: string | null }[] };
      // Provider ids and counts are language-neutral; the error text comes
      // from the provider itself and is shown verbatim.
      setMsg(
        (body.results ?? [])
          .map((r) => `${r.source}: ${r.error ? r.error.slice(0, 50) : r.inserted}`)
          .join(' · '),
      );
      router.refresh();
    } catch {
      setMsg('network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={sync}
        disabled={busy}
        className="rounded border border-line px-3 py-1.5 text-2xs text-ink-muted hover:text-ink disabled:opacity-50"
      >
        {busy ? busyLabel : label}
      </button>
      {msg && <span className="text-2xs text-ink-faint">{msg}</span>}
    </div>
  );
}

/** Add any catalogued instrument to the watchlist. */
export function AddToWatchlistButton({
  symbol,
  displayName,
  exchangeId,
  assetClass,
  currency,
  alreadyTracked,
  labels,
}: {
  symbol: string;
  displayName: string;
  exchangeId: string;
  assetClass: string;
  currency: string;
  alreadyTracked: boolean;
  labels: { track: string; tracked: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(alreadyTracked);
  const [error, setError] = useState<string | null>(null);
  const [style, setStyle] = useState('swing');
  const [picking, setPicking] = useState(false);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, displayName, exchangeId, assetClass, currency, tradingStyle: style }),
      });
      const body = (await res.json()) as { error?: string };
      if (res.ok) {
        setDone(true);
        setPicking(false);
        router.refresh();
      } else {
        setError(body.error ?? 'failed');
      }
    } catch {
      setError('network error');
    } finally {
      setBusy(false);
    }
  }

  if (done) return <span className="text-2xs text-up">{labels.tracked}</span>;

  if (!picking) {
    return (
      <button
        onClick={() => setPicking(true)}
        className="rounded border border-line-strong px-2 py-0.5 text-2xs text-ink-muted hover:text-ink"
      >
        {labels.track}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <select
        value={style}
        onChange={(e) => setStyle(e.target.value)}
        className="rounded border border-line bg-bg-inset px-1 py-0.5 text-2xs text-ink"
      >
        {TRADING_STYLES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <button onClick={add} disabled={busy} className="rounded bg-accent px-2 py-0.5 text-2xs font-medium text-bg disabled:opacity-50">
        {busy ? '…' : 'ok'}
      </button>
      {error && <span className="text-2xs text-down">{error}</span>}
    </span>
  );
}
