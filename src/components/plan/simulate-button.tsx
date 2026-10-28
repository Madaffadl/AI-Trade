'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface SimulateLabels {
  simulate: string;
  simulating: string;
  started: string;
  pending: string;
  viewSims: string;
  failed: string;
  errors: Record<'not_actionable' | 'already_simulating' | 'max_positions' | 'too_small' | 'daily_stop', string>;
}

/** Starts a paper trade for a setup; the server prices it against the live order book. */
export function SimulateButton({ setupId, labels }: { setupId: string; labels: SimulateLabels }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    const res = await fetch('/api/simulations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupId }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as { filled?: boolean; error?: string } | undefined;
    if (res?.ok) {
      setResult({ ok: true, message: body?.filled ? labels.started : labels.pending });
      router.refresh();
    } else {
      const known = body?.error && body.error in labels.errors ? labels.errors[body.error as keyof SimulateLabels['errors']] : null;
      setResult({ ok: false, message: known ?? `${labels.failed}${body?.error ? `: ${body.error}` : ''}` });
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        aria-busy={busy}
        className="inline-flex min-h-[44px] items-center rounded border border-up/40 bg-up-dim px-3 text-xs font-semibold text-up hover:bg-up/20 disabled:cursor-wait disabled:opacity-70"
      >
        {busy ? labels.simulating : labels.simulate}
      </button>
      {result && (
        <p role="status" className={`text-2xs ${result.ok ? 'text-up' : 'text-down'}`}>
          {result.message}{' '}
          {result.ok && (
            <Link href="/simulations" className="text-accent hover:underline">
              {labels.viewSims}
            </Link>
          )}
        </p>
      )}
    </div>
  );
}
