'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface TradingFormLabels {
  fCapital: string;
  fReserved: string;
  fRisk: string;
  fAllocation: string;
  fMaxPositions: string;
  fDailyLoss: string;
  fMinRr: string;
  fTax: string;
  fOther: string;
  fMinVolume: string;
  fMaxSpread: string;
  fUniverse: string;
  fSimCapital: string;
  fAutoSimulate: string;
  save: string;
  saved: string;
  saveFailed: string;
}

export type TradingFormValues = Record<
  | 'capitalIdr'
  | 'reservedIdr'
  | 'riskPercent'
  | 'maxAllocationPercent'
  | 'maxOpenPositions'
  | 'maxDailyLossPercent'
  | 'minNetRiskReward'
  | 'sellTaxPercent'
  | 'otherFeePercentPerSide'
  | 'minVolumeIdr'
  | 'maxSpreadPercent'
  | 'universeSize'
  | 'simStartCapitalIdr',
  number
>;

const FIELDS: { key: keyof TradingFormValues; label: keyof TradingFormLabels; step: string }[] = [
  { key: 'capitalIdr', label: 'fCapital', step: '1000' },
  { key: 'reservedIdr', label: 'fReserved', step: '1000' },
  { key: 'riskPercent', label: 'fRisk', step: '0.1' },
  { key: 'maxAllocationPercent', label: 'fAllocation', step: '1' },
  { key: 'maxOpenPositions', label: 'fMaxPositions', step: '1' },
  { key: 'maxDailyLossPercent', label: 'fDailyLoss', step: '0.5' },
  { key: 'minNetRiskReward', label: 'fMinRr', step: '0.1' },
  { key: 'sellTaxPercent', label: 'fTax', step: '0.01' },
  { key: 'otherFeePercentPerSide', label: 'fOther', step: '0.0001' },
  { key: 'minVolumeIdr', label: 'fMinVolume', step: '100000000' },
  { key: 'maxSpreadPercent', label: 'fMaxSpread', step: '0.05' },
  { key: 'universeSize', label: 'fUniverse', step: '1' },
  { key: 'simStartCapitalIdr', label: 'fSimCapital', step: '1000' },
];

/** Capital, risk limits, cost assumptions and scan filters - stored server-side, validated there. */
export function TradingSettingsForm({
  initial,
  autoSimulate: initialAuto,
  labels,
}: {
  initial: TradingFormValues;
  autoSimulate: boolean;
  labels: TradingFormLabels;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, String(v)])),
  );
  const [autoSimulate, setAutoSimulate] = useState(initialAuto);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    const body = { ...Object.fromEntries(FIELDS.map((f) => [f.key, Number(values[f.key])])), autoSimulate };
    const res = await fetch('/api/settings/trading', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (res?.ok) {
      setStatus({ ok: true, message: labels.saved });
      router.refresh();
    } else {
      const err = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
      setStatus({ ok: false, message: `${labels.saveFailed}${err?.error ? `: ${err.error}` : ''}` });
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="block text-2xs text-ink-muted">
            {labels[f.label]}
            <input
              type="number"
              inputMode="decimal"
              step={f.step}
              min="0"
              required
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              className="mt-1 block min-h-[44px] w-full rounded border border-line bg-bg-inset px-3 text-sm text-ink"
            />
          </label>
        ))}
      </div>
      <label className="flex min-h-[44px] items-center gap-2 text-xs text-ink">
        <input
          type="checkbox"
          checked={autoSimulate}
          onChange={(e) => setAutoSimulate(e.target.checked)}
          className="h-4 w-4 accent-[#3d8bfd]"
        />
        {labels.fAutoSimulate}
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex min-h-[44px] items-center rounded border border-accent/40 bg-accent-dim px-4 text-xs font-semibold text-accent hover:bg-accent/20 disabled:opacity-70"
        >
          {labels.save}
        </button>
        {status && (
          <p role="status" className={`text-2xs ${status.ok ? 'text-up' : 'text-down'}`}>
            {status.message}
          </p>
        )}
      </div>
    </form>
  );
}
