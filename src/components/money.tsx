import type { ConvertedMoney } from '@/lib/fx/service';
import { formatUtc } from '@/lib/format';

/**
 * Renders a price, marking any FX conversion explicitly.
 *
 * A converted value always carries "≈" and a tooltip naming the rate, its age
 * and the native amount. The underlying number is never silently replaced:
 * signals, plans and profit/loss are always computed in the native currency.
 */
export function Money({ money, digitsHint }: { money: ConvertedMoney; digitsHint?: number }) {
  if (money.value === null) return <span className="text-ink-faint">—</span>;

  const digits =
    digitsHint ??
    (money.currency === 'IDR'
      ? 0
      : Math.abs(money.value) >= 1000
        ? 2
        : Math.abs(money.value) >= 1
          ? 2
          : 6);

  const text = money.value.toLocaleString(money.currency === 'IDR' ? 'id-ID' : 'en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

  if (!money.converted) {
    return (
      <span className="num whitespace-nowrap">
        {text} <span className="text-ink-faint">{money.currency}</span>
      </span>
    );
  }

  const nativeText = money.nativeValue?.toLocaleString('en-US', { maximumFractionDigits: 8 }) ?? '—';
  const ageHours = money.rateAgeMs === null ? null : Math.round(money.rateAgeMs / 3_600_000);

  return (
    <span
      className="num whitespace-nowrap"
      title={
        `Dikonversi dari ${nativeText} ${money.nativeCurrency}` +
        (money.rate ? ` · kurs 1 ${money.nativeCurrency} = ${money.rate.toLocaleString('id-ID', { maximumFractionDigits: 6 })} ${money.currency}` : '') +
        (ageHours !== null ? ` · kurs berumur ~${ageHours} jam` : '') +
        (money.note ? ` · ${money.note}` : '')
      }
    >
      <span className="text-ink-faint">≈</span> {text} <span className="text-ink-faint">{money.currency}</span>
    </span>
  );
}

/** Footer line explaining the conversion currently in effect. */
export function FxDisclosure({
  target,
  providerUpdatedAtMs,
}: {
  target: string;
  providerUpdatedAtMs: number | null;
}) {
  if (target === 'native') return null;
  return (
    <p className="text-2xs text-ink-faint">
      Harga bertanda <span className="text-ink-muted">≈</span> dikonversi ke {target} hanya untuk tampilan
      {providerUpdatedAtMs ? ` · kurs diperbarui ${formatUtc(providerUpdatedAtMs)}` : ' · kurs tidak tersedia'}.
      Sinyal, rencana, dan untung/rugi selalu dihitung dalam mata uang asli transaksi — konversi tidak pernah dipakai
      untuk perhitungan.
    </p>
  );
}
