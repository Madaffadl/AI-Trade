'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface SimActionLabels {
  closeAll: string;
  closeHalf: string;
  cancel: string;
  working: string;
  failed: string;
}

/** Close all / half of an open simulation at the live bid, or cancel a pending one. */
export function SimActions({ id, status, labels }: { id: string; status: string; labels: SimActionLabels }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: 'close' | 'cancel', fraction = 1) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/simulations/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, fraction }),
    }).catch(() => null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
      setError(body?.error ?? labels.failed);
    }
    router.refresh();
    setBusy(false);
  }

  const btn =
    'inline-flex min-h-[32px] items-center rounded border border-line-strong px-2 text-2xs text-ink-muted hover:text-ink disabled:opacity-60';
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {status === 'open' ? (
        <>
          <button type="button" className={btn} disabled={busy} onClick={() => act('close', 1)}>
            {busy ? labels.working : labels.closeAll}
          </button>
          <button type="button" className={btn} disabled={busy} onClick={() => act('close', 0.5)}>
            {labels.closeHalf}
          </button>
        </>
      ) : (
        <button type="button" className={btn} disabled={busy} onClick={() => act('cancel')}>
          {busy ? labels.working : labels.cancel}
        </button>
      )}
      {error && (
        <span role="alert" className="text-2xs text-down">
          {labels.failed}: {error}
        </span>
      )}
    </div>
  );
}
