'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface RefreshLabels {
  refresh: string;
  refreshing: string;
  failed: string;
}

/** Runs a job on demand (a scan by default), then reloads the server-rendered page. */
export function RefreshScanButton({ labels, endpoint = '/api/scan' }: { labels: RefreshLabels; endpoint?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      if (!res.ok && res.status !== 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        aria-busy={busy}
        className="inline-flex min-h-[44px] items-center rounded border border-accent/40 bg-accent-dim px-3 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 disabled:cursor-wait disabled:opacity-70"
      >
        {busy ? labels.refreshing : labels.refresh}
      </button>
      {error && (
        <p role="alert" className="text-2xs text-down">
          {labels.failed}: {error}
        </p>
      )}
    </div>
  );
}
