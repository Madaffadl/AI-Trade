import Link from 'next/link';
import { ensureDefaultWatchlist, listWatchlist, loadCandles } from '@/lib/db/repo';
import { evaluateForecastModels, forecastNextBar } from '@/lib/forecast/baselines';
import { formatNumber, formatPrice } from '@/lib/format';
import { Card, EmptyState, InfoNote, Table, WarningNote } from '@/components/ui';
import { getMessages } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

export default async function ForecastsPage() {
  const t = await getMessages();
  const watchlistId = await ensureDefaultWatchlist();
  const entries = await listWatchlist(watchlistId);

  const blocks = await Promise.all(
    entries.map(async (e) => {
      const stored = await loadCandles(e.id, '1d', 400);
      const bars = stored.candles.filter((c) => !c.isPartial);
      return {
        entry: e,
        bars: bars.length,
        evaluations: bars.length >= 60 ? evaluateForecastModels(bars, 60) : [],
        next: bars.length >= 60 ? forecastNextBar(bars) : [],
      };
    }),
  );

  const withData = blocks.filter((b) => b.evaluations.length > 0);
  const anyBeatsNaive = withData.some((b) => b.evaluations.some((e) => e.modelId !== 'naive' && e.beatsNaive));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink">{t.forecasts.title}</h1>
        <p className="text-2xs text-ink-muted">{t.forecasts.subtitle}</p>
      </div>

      <WarningNote>{anyBeatsNaive ? t.forecasts.warningBeat : t.forecasts.warningNoBeat}</WarningNote>

      {withData.length === 0 ? (
        <EmptyState
          title={t.forecasts.notEnough}
          body={t.forecasts.notEnoughBody}
        />
      ) : (
        withData.map((b) => (
          <Card
            key={b.entry.id}
            title={
              <span>
                {b.entry.symbol} <span className="text-2xs font-normal text-ink-faint">{b.entry.exchangeId} · 1d</span>
              </span>
            }
            subtitle={t.forecasts.barsStored(b.bars)}
            actions={
              <Link href={`/assets/${b.entry.id}?tf=1d`} className="inline-flex min-h-[24px] items-center text-2xs text-accent hover:underline">
                {t.forecasts.assetLink}
              </Link>
            }
          >
            <Table
              head={[
                t.forecasts.model,
                t.forecasts.observations,
                'MAE',
                'RMSE',
                t.forecasts.directionalAccuracy,
                t.forecasts.rmseVsNaive,
                t.forecasts.nextBar,
                t.forecasts.verdict,
              ]}
            >
              {b.evaluations.map((ev) => {
                const next = b.next.find((n) => n.model === ev.modelId);
                return (
                  <tr key={ev.modelId}>
                    <td className="px-2 py-2 text-xs text-ink">{ev.label}</td>
                    <td className="num px-2 py-2 text-ink-muted">{ev.accuracy.observations}</td>
                    <td className="num px-2 py-2 text-ink-muted">{formatNumber(ev.accuracy.mae, 2)}</td>
                    <td className="num px-2 py-2 text-ink-muted">{formatNumber(ev.accuracy.rmse, 2)}</td>
                    <td className="num px-2 py-2 text-ink-muted">
                      {formatNumber(ev.accuracy.directionalAccuracyPct, 1)}%
                    </td>
                    <td
                      className={`num px-2 py-2 ${
                        ev.beatsNaive === null ? 'text-ink-faint' : ev.beatsNaive ? 'text-up' : 'text-down'
                      }`}
                    >
                      {formatNumber(ev.rmseVsNaive, 3)}
                    </td>
                    <td className="num px-2 py-2 text-ink-muted">
                      {formatPrice(next?.predictedClose ?? null)}
                      {next?.lowerBand && next?.upperBand ? (
                        <span className="block text-2xs text-ink-faint">
                          ±1σ {formatPrice(next.lowerBand)}–{formatPrice(next.upperBand)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 text-2xs text-ink-faint">{ev.verdict}</td>
                  </tr>
                );
              })}
            </Table>
          </Card>
        ))
      )}

      <InfoNote>{t.forecasts.footer}</InfoNote>
    </div>
  );
}
