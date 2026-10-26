'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface ThresholdLabels {
  direction: string;
  above: string;
  below: string;
  price: string;
  add: string;
  adding: string;
  added: string;
  failed: string;
  none: string;
  active: string;
  triggered: string;
  remove: string;
  listTitle: string;
}

export interface ThresholdRow {
  id: string;
  direction: string;
  price: number;
  active: number;
  triggered_at_ms: number | null;
}

/**
 * Price-threshold form.
 *
 * The API for these existed from the start; nothing in the interface ever
 * called it, so the feature was reachable only with curl. This is that missing
 * surface.
 */
export function ThresholdForm({
  assetId,
  currency,
  rows,
  labels,
}: {
  assetId: string;
  currency: string;
  rows: ThresholdRow[];
  labels: ThresholdLabels;
}) {
  const router = useRouter();
  const [direction, setDirection] = useState<'above' | 'below'>('above');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch('/api/thresholds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId, direction, price: Number(price) }),
      });
      const body = (await res.json()) as { error?: string };
      if (res.ok) {
        setStatus(labels.added);
        setPrice('');
        router.refresh();
      } else {
        setStatus(body.error ?? labels.failed);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : labels.failed);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await fetch('/api/thresholds', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <label className="text-2xs text-ink-muted">
          {labels.direction}
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as 'above' | 'below')}
            className="mt-1 block min-h-[44px] rounded border border-line bg-bg-inset px-2 py-1.5 text-xs text-ink focus:border-accent"
          >
            <option value="above">{labels.above}</option>
            <option value="below">{labels.below}</option>
          </select>
        </label>
        <label className="text-2xs text-ink-muted">
          {labels.price} ({currency})
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            required
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="mt-1 block min-h-[44px] w-44 rounded border border-line bg-bg-inset px-2 py-1.5 text-xs text-ink focus:border-accent"
          />
        </label>
        <button
          type="submit"
          disabled={busy || price === ''}
          className="inline-flex min-h-[44px] items-center rounded border border-accent/40 bg-accent-dim px-3 py-2 text-xs font-medium text-accent transition-colors hover:border-accent disabled:opacity-50"
        >
          {busy ? labels.adding : labels.add}
        </button>
      </form>

      {status && <p className="mt-2 text-2xs text-ink-muted">{status}</p>}

      <div className="mt-4">
        <p className="mb-1.5 text-2xs uppercase tracking-wide text-ink-faint">{labels.listTitle}</p>
        {rows.length === 0 ? (
          <p className="text-2xs text-ink-faint">{labels.none}</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded border border-line bg-bg-inset px-3 py-2">
                <span className="text-2xs text-ink-muted">
                  {r.direction === 'above' ? labels.above : labels.below}{' '}
                  <span className="num text-ink">
                    {r.price.toLocaleString('en-US', { maximumFractionDigits: 8 })} {currency}
                  </span>
                </span>
                <span
                  className={`inline-flex items-center rounded border px-1.5 py-0.5 text-2xs ${
                    r.triggered_at_ms ? 'border-warn/30 bg-warn-dim text-warn' : 'border-up/30 bg-up-dim text-up'
                  }`}
                >
                  {r.triggered_at_ms ? labels.triggered : labels.active}
                </span>
                <button
                  type="button"
                  onClick={() => remove(r.id)}
                  disabled={busy}
                  className="ml-auto inline-flex min-h-[28px] items-center rounded border border-line px-2 py-1 text-2xs text-ink-muted transition-colors hover:border-down/40 hover:text-down disabled:opacity-50"
                >
                  {labels.remove}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
