import Link from 'next/link';
import type { ScanRow } from '@/lib/market/scanner';
import { convertForDisplay, type FxContext } from '@/lib/fx/service';
import { directionClass, formatAge, formatNumber, formatPercentSigned } from '@/lib/format';
import { Money } from './money';
import type { Messages } from '@/lib/i18n/en';
import { ActionBadge, DataQualityBadge, RegimeBadge, Table } from './ui';
import { HeadHint } from './hint';

const TREND_TONE: Record<string, string> = {
  bullish: 'text-up',
  bearish: 'text-down',
  neutral: 'text-flat',
  unknown: 'text-ink-faint',
};

/** Glossary entry for a signal action. */
export function actionHint(t: Messages, action: string): string {
  switch (action) {
    case 'BUY':
      return t.glossary.signalBuy;
    case 'SELL':
      return t.glossary.signalSell;
    case 'HOLD':
      return t.glossary.signalHold;
    default:
      return t.glossary.signalWait;
  }
}

export function ScanTable({ rows, fx, t }: { rows: ScanRow[]; fx: FxContext; t: Messages }) {
  const trendLabel: Record<string, string> = {
    bullish: t.scanner.bullish,
    bearish: t.scanner.bearish,
    neutral: t.scanner.neutral,
    unknown: t.common.unknown,
  };
  return (
    <Table
      caption={t.scanner.title}
      head={[
        t.common.asset,
        <HeadHint key="tf" label="TF" text={t.glossary.timeframe} />,
        t.common.price,
        t.common.change,
        '20-bar',
        <HeadHint key="rsi" label="RSI" text={t.glossary.rsi} />,
        <HeadHint key="atr" label="ATR%" text={t.glossary.atrPct} />,
        <HeadHint key="vol" label={t.scanner.relVol} text={t.glossary.relativeVolume} />,
        <HeadHint key="trend" label={t.common.trend} text={t.glossary.trend} />,
        <HeadHint key="regime" label={t.common.regime} text={t.glossary.regime} />,
        <HeadHint key="signal" label={t.common.signal} text={t.glossary.setupStrength} />,
        <HeadHint key="data" label={t.common.data} text={t.glossary.dataQuality} />,
        t.common.updated,
      ]}
    >
      {rows.map((r) => (
        <tr key={`${r.assetId}-${r.timeframe}`} className="hover:bg-bg-inset/60">
          <td className="px-2 py-2">
            <Link href={`/assets/${r.assetId}?tf=${r.timeframe}`} className="block">
              <span className="font-medium text-ink">{r.symbol}</span>
              <span className="ml-1.5 text-2xs text-ink-faint">{r.exchangeId}</span>
              <p className="truncate text-2xs text-ink-faint">{r.displayName}</p>
            </Link>
          </td>
          <td className="px-2 py-2 text-2xs text-ink-muted">{r.timeframe}</td>
          <td className="whitespace-nowrap px-2 py-2 text-ink">
            <Money money={convertForDisplay(r.price, r.currency, fx)} />
          </td>
          <td className={`num whitespace-nowrap px-2 py-2 ${directionClass(r.changePct)}`}>
            {formatPercentSigned(r.changePct)}
          </td>
          <td className={`num whitespace-nowrap px-2 py-2 ${directionClass(r.change20Pct)}`}>
            {formatPercentSigned(r.change20Pct)}
          </td>
          <td className="num px-2 py-2 text-ink-muted">{formatNumber(r.rsi, 1)}</td>
          <td className="num px-2 py-2 text-ink-muted">{formatNumber(r.atrPct, 2)}</td>
          <td className="num px-2 py-2 text-ink-muted">
            {r.relativeVolume === null ? <span title={t.scanner.noVolume}>—</span> : formatNumber(r.relativeVolume, 2)}
          </td>
          <td className={`px-2 py-2 text-2xs font-medium ${TREND_TONE[r.trend]}`}>{trendLabel[r.trend] ?? r.trend}</td>
          <td className="px-2 py-2">
            <RegimeBadge regime={r.regime} />
          </td>
          <td className="px-2 py-2">
            {r.latestSignal ? (
              <span className="inline-flex items-center gap-1">
                <ActionBadge action={r.latestSignal.action} hint={actionHint(t, r.latestSignal.action)} />
                <span className="text-2xs text-ink-faint">{formatAge(r.latestSignal.generatedAtMs)}</span>
              </span>
            ) : (
              <span className="text-2xs text-ink-faint">{t.common.none}</span>
            )}
          </td>
          <td className="px-2 py-2">
            <DataQualityBadge quality={r.quality} labels={t.quality} />
          </td>
          <td className="px-2 py-2 text-2xs text-ink-faint">
            {formatAge(r.fetchedAtMs)}
            {r.fromCache && <span className="ml-1 text-ink-faint">({t.ui.aiCached})</span>}
          </td>
        </tr>
      ))}
    </Table>
  );
}

export function ReasonList({ rows, t }: { rows: ScanRow[]; t: Messages }) {
  const flagged = rows.filter((r) => r.reasons.length > 0);
  if (flagged.length === 0) return null;
  return (
    <ul className="space-y-2">
      {flagged.map((r) => (
        <li key={r.assetId} className="rounded border border-line bg-bg-inset px-3 py-2">
          <div className="flex items-center gap-2">
            <Link href={`/assets/${r.assetId}`} className="text-xs font-medium text-ink hover:text-accent">
              {r.symbol}
            </Link>
            <span className="text-2xs text-ink-faint">{r.exchangeId} · {r.timeframe}</span>
            <DataQualityBadge quality={r.quality} labels={t.quality} />
          </div>
          <ul className="mt-1 space-y-0.5">
            {r.reasons.map((reason, i) => (
              <li key={i} className="text-2xs text-ink-muted">
                • {reason}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
