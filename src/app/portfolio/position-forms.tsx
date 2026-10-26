'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TIMEFRAMES, TRADING_STYLES } from '@/lib/market/types';
import { VENUES } from '@/lib/positions/types';
import { fill, type PositionFormLabels } from '@/lib/i18n/client-labels';

interface AssetOption {
  id: string;
  symbol: string;
  displayName: string;
  exchangeId: string;
  currency: string;
}

/** Venue display name from the serialisable label bag. */
function venueLabel(t: PositionFormLabels, venue: string): string {
  switch (venue) {
    case 'indodax':
      return t.venueIndodax;
    case 'pluang':
      return t.venuePluang;
    case 'stockbit':
      return t.venueStockbit;
    default:
      return t.venueOther;
  }
}

const field = 'mt-1 w-full rounded border border-line bg-bg-inset px-2 py-1.5 min-h-[44px] text-xs text-ink focus:border-accent';
const label = 'block text-2xs text-ink-faint';

/** Record a purchase that already happened at a real venue. */
export function RecordBuyForm({
  assets,
  prefill,
  t,
}: {
  assets: AssetOption[];
  t: PositionFormLabels;
  prefill?: {
    assetId?: string;
    entryPrice?: number;
    stopLoss?: number;
    takeProfit1?: number;
    takeProfit2?: number;
    timeframe?: string;
    tradingStyle?: string;
    signalId?: string;
  };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(Boolean(prefill?.assetId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const [form, setForm] = useState({
    assetId: prefill?.assetId ?? assets[0]?.id ?? '',
    venue: 'indodax',
    quantity: '',
    entryPrice: prefill?.entryPrice ? String(prefill.entryPrice) : '',
    entryDate: new Date().toISOString().slice(0, 16),
    entryFee: '',
    stopLoss: prefill?.stopLoss ? String(prefill.stopLoss) : '',
    takeProfit1: prefill?.takeProfit1 ? String(prefill.takeProfit1) : '',
    takeProfit2: prefill?.takeProfit2 ? String(prefill.takeProfit2) : '',
    timeframe: prefill?.timeframe ?? '1d',
    tradingStyle: prefill?.tradingStyle ?? 'swing',
    notes: '',
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const asset = assets.find((a) => a.id === form.assetId);
  const num = (v: string) => (v.trim() === '' ? null : Number(v));

  const qty = num(form.quantity);
  const entry = num(form.entryPrice);
  const cost = qty !== null && entry !== null ? qty * entry : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch('/api/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetId: form.assetId,
          venue: form.venue,
          quantity: Number(form.quantity),
          entryPrice: Number(form.entryPrice),
          entryAtMs: new Date(form.entryDate).getTime(),
          entryFee: num(form.entryFee),
          stopLoss: num(form.stopLoss),
          takeProfit1: num(form.takeProfit1),
          takeProfit2: num(form.takeProfit2),
          timeframe: form.timeframe,
          tradingStyle: form.tradingStyle,
          openedFromSignalId: prefill?.signalId ?? null,
          notes: form.notes.trim() === '' ? null : form.notes,
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (res.ok) {
        setOk(t.saved);
        setForm((f) => ({ ...f, quantity: '', entryPrice: '', entryFee: '', notes: '' }));
        router.refresh();
      } else {
        setError(body.error ?? t.saveFailed);
      }
    } catch {
      setError(t.networkError);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg">
        {t.open}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className={label}>{t.asset}</label>
          <select value={form.assetId} onChange={set('assetId')} className={field} required>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.symbol} · {a.exchangeId} ({a.currency})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>{t.venue}</label>
          <select value={form.venue} onChange={set('venue')} className={field}>
            {VENUES.map((v) => (
              <option key={v} value={v}>
                {venueLabel(t, v)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>{t.quantity}</label>
          <input type="number" step="any" min="0" value={form.quantity} onChange={set('quantity')} className={field} required placeholder="0.005" />
        </div>
        <div>
          <label className={label}>{fill(t.entryPriceTemplate, { currency: asset?.currency ?? '' })}</label>
          <input type="number" step="any" min="0" value={form.entryPrice} onChange={set('entryPrice')} className={field} required placeholder="1470223000" />
        </div>
        <div>
          <label className={label}>{t.buyDate}</label>
          <input type="datetime-local" value={form.entryDate} onChange={set('entryDate')} className={field} required />
        </div>
        <div>
          <label className={label}>{t.fee}</label>
          <input type="number" step="any" min="0" value={form.entryFee} onChange={set('entryFee')} className={field} placeholder={t.feePlaceholder} />
        </div>
        <div>
          <label className={label}>{t.planTimeframe}</label>
          <select value={form.timeframe} onChange={set('timeframe')} className={field}>
            {TIMEFRAMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>{t.tradingStyle}</label>
          <select value={form.tradingStyle} onChange={set('tradingStyle')} className={field}>
            {TRADING_STYLES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>{t.stopLoss}</label>
          <input type="number" step="any" min="0" value={form.stopLoss} onChange={set('stopLoss')} className={field} placeholder={t.stopLossPlaceholder} />
        </div>
        <div>
          <label className={label}>{t.target1}</label>
          <input type="number" step="any" min="0" value={form.takeProfit1} onChange={set('takeProfit1')} className={field} placeholder={t.target1Placeholder} />
        </div>
        <div>
          <label className={label}>{t.target2}</label>
          <input type="number" step="any" min="0" value={form.takeProfit2} onChange={set('takeProfit2')} className={field} />
        </div>
        <div>
          <label className={label}>{t.notes}</label>
          <input type="text" maxLength={200} value={form.notes} onChange={set('notes')} className={field} placeholder={t.notesPlaceholder} />
        </div>
      </div>

      {cost !== null && asset && (
        <p className="text-2xs text-ink-muted">
          {t.capital}: <span className="num text-ink">{cost.toLocaleString('id-ID')} {asset.currency}</span>
          {num(form.stopLoss) !== null && qty !== null && entry !== null && (
            <>
              {' · '}{t.riskIfStopped}:{' '}
              <span className="num text-down">
                {((num(form.stopLoss)! - entry) * qty).toLocaleString('id-ID', { maximumFractionDigits: 0 })} {asset.currency}
              </span>
            </>
          )}
          {num(form.takeProfit1) !== null && qty !== null && entry !== null && (
            <>
              {' · '}{t.profitAtTarget}:{' '}
              <span className="num text-up">
                {((num(form.takeProfit1)! - entry) * qty).toLocaleString('id-ID', { maximumFractionDigits: 0 })} {asset.currency}
              </span>
            </>
          )}
        </p>
      )}

      {error && <p className="text-2xs text-down">{error}</p>}
      {ok && <p className="text-2xs text-up">{ok}</p>}

      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50">
          {busy ? t.saving : t.submit}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded border border-line px-3 py-1.5 text-xs text-ink-muted">
          {t.cancel}
        </button>
      </div>
      <p className="text-2xs text-ink-faint">
        {t.disclaimer}
      </p>
    </form>
  );
}

/** Record the sale that already happened. */
export function ClosePositionForm({
  positionId,
  symbol,
  currency,
  suggestedPrice,
  t,
}: {
  positionId: string;
  symbol: string;
  currency: string;
  suggestedPrice: number | null;
  t: PositionFormLabels;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exitPrice, setExitPrice] = useState(suggestedPrice ? String(suggestedPrice) : '');
  const [exitFee, setExitFee] = useState('');
  const [reason, setReason] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/positions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: positionId,
          exitPrice: Number(exitPrice),
          exitAtMs: Date.now(),
          exitFee: exitFee.trim() === '' ? null : Number(exitFee),
          exitReason: reason.trim() === '' ? null : reason,
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (res.ok) {
        setOpen(false);
        router.refresh();
      } else {
        setError(body.error ?? t.closeFailed);
      }
    } catch {
      setError(t.networkError);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded border border-line-strong px-2 py-1 text-2xs text-ink-muted hover:text-ink">
        {t.closeOpen}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-2 rounded border border-line bg-bg-inset p-3">
      <p className="text-2xs text-ink-muted">
        {fill(t.closeTitleTemplate, { symbol })}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className={label}>{fill(t.exitPriceTemplate, { currency })}</label>
          <input type="number" step="any" min="0" value={exitPrice} onChange={(e) => setExitPrice(e.target.value)} className={field} required />
        </div>
        <div>
          <label className={label}>{t.fee}</label>
          <input type="number" step="any" min="0" value={exitFee} onChange={(e) => setExitFee(e.target.value)} className={field} />
        </div>
        <div>
          <label className={label}>{t.exitReason}</label>
          <input type="text" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} className={field} placeholder={t.exitReasonPlaceholder} />
        </div>
      </div>
      {error && <p className="text-2xs text-down">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="rounded bg-accent px-3 py-1 text-2xs font-medium text-bg disabled:opacity-50">
          {busy ? t.saving : t.closeSubmit}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded border border-line px-3 py-1 text-2xs text-ink-muted">
          {t.cancel}
        </button>
      </div>
    </form>
  );
}
