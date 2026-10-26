import { forwardPerformanceByStrategy } from '@/lib/evaluation/forward';
import { ensureDefaultWatchlist, listWatchlist, loadCandles } from '@/lib/db/repo';
import { runBacktest } from '@/lib/evaluation/backtest';
import { STRATEGIES } from '@/lib/strategies';
import { formatNumber, formatPercentSigned } from '@/lib/format';
import { Card, EmptyState, InfoNote, Stat, Table, WarningNote } from '@/components/ui';
import { HeadHint } from '@/components/hint';
import { getMessages } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

export default async function EvaluationPage() {
  const t = await getMessages();
  const forward = await forwardPerformanceByStrategy();

  // Backtests run over candles already stored locally - no provider calls.
  const watchlistId = await ensureDefaultWatchlist();
  const entries = await listWatchlist(watchlistId);
  const backtests = [];
  for (const entry of entries) {
    const stored = await loadCandles(entry.id, '1d', 2000);
    const bars = stored.candles.filter((c) => !c.isPartial);
    if (bars.length < 160) continue;
    for (const strategy of STRATEGIES) {
      if (!strategy.timeframes.includes('1d') || !strategy.assetClasses.includes(entry.assetClass)) continue;
      backtests.push({
        symbol: entry.symbol,
        exchangeId: entry.exchangeId,
        result: runBacktest({ strategy, bars, timeframe: '1d', assetClass: entry.assetClass }),
      });
    }
  }

  const totalForwardTrades = forward.reduce((s, f) => s + f.metrics.trades, 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink">{t.evaluation.title}</h1>
        <p className="text-2xs text-ink-muted">{t.evaluation.subtitle}</p>
      </div>

      <WarningNote>{t.evaluation.warning}</WarningNote>

      <Card
        title={t.evaluation.forwardTitle}
        subtitle={t.glossary.forwardEval}
      >
        {totalForwardTrades === 0 ? (
          <EmptyState
            title={t.evaluation.noForward}
            body={t.evaluation.noForwardBody}
          />
        ) : (
          <Table
            head={[
              t.common.strategy,
              <HeadHint key="tr" label={t.evaluation.trades} text={t.glossary.sampleSize} />,
              <HeadHint key="wr" label={t.evaluation.winRate} text={t.glossary.winRate} />,
              t.evaluation.avgGain,
              t.evaluation.avgLoss,
              <HeadHint key="exp" label={t.evaluation.expectancy} text={t.glossary.expectancy} />,
              <HeadHint key="expr" label={t.evaluation.expectancyR} text={t.glossary.rMultiple} />,
              <HeadHint key="pf" label={t.evaluation.profitFactor} text={t.glossary.profitFactor} />,
              <HeadHint key="dd" label={t.evaluation.maxDd} text={t.glossary.maxDrawdown} />,
              <HeadHint key="ov" label={t.evaluation.excludedOverlaps} text={t.glossary.overlapping} />,
            ]}
          >
            {forward.map((f) => (
              <tr key={f.strategyId}>
                <td className="px-2 py-2 text-xs text-ink">{f.strategyId}</td>
                <td className="num px-2 py-2 text-ink-muted">{f.metrics.trades}</td>
                <td className="num px-2 py-2 text-ink-muted">{formatNumber(f.metrics.winRatePct, 1)}%</td>
                <td className="num px-2 py-2 text-up">{formatPercentSigned(f.metrics.averageGainPct)}</td>
                <td className="num px-2 py-2 text-down">{formatPercentSigned(f.metrics.averageLossPct)}</td>
                <td className={`num px-2 py-2 ${(f.metrics.expectancyPct ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>
                  {formatPercentSigned(f.metrics.expectancyPct)}
                </td>
                <td className="num px-2 py-2 text-ink-muted">{formatNumber(f.metrics.expectancyR, 3)}</td>
                <td className="num px-2 py-2 text-ink-muted">
                  {f.metrics.profitFactor === null ? t.evaluation.undefined : formatNumber(f.metrics.profitFactor, 2)}
                </td>
                <td className="num px-2 py-2 text-ink-muted">{formatNumber(f.metrics.maxDrawdownPct, 2)}%</td>
                <td className="num px-2 py-2 text-ink-faint">{f.metrics.overlappingExcluded}</td>
              </tr>
            ))}
          </Table>
        )}
        {forward.some((f) => f.metrics.sampleWarning) && (
          <ul className="mt-3 space-y-1">
            {forward
              .filter((f) => f.metrics.sampleWarning)
              .map((f) => (
                <li key={f.strategyId} className="text-2xs text-warn">
                  {f.strategyId}: {f.metrics.sampleWarning}
                </li>
              ))}
          </ul>
        )}
      </Card>

      <Card
        title={t.evaluation.backtestTitle}
        subtitle={t.glossary.backtest}
      >
        {backtests.length === 0 ? (
          <EmptyState
            title={t.evaluation.noBacktest}
            body={t.evaluation.noBacktestBody}
          />
        ) : (
          <div className="space-y-4">
            {backtests.map((b, i) => {
              const m = b.result.metrics;
              const beatBenchmark =
                b.result.benchmarkBuyHoldPct !== null && m.totalReturnPct > b.result.benchmarkBuyHoldPct;
              return (
                <div key={i} className="rounded border border-line bg-bg-inset p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-ink">{b.symbol}</span>
                    <span className="text-2xs text-ink-faint">{b.exchangeId}</span>
                    <span className="text-2xs text-ink-muted">
                      {b.result.strategyId}@{b.result.strategyVersion}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    <Stat label={t.evaluation.barsTested} value={b.result.barsTested} hint={t.glossary.backtest} />
                    <Stat label={t.evaluation.trades} value={m.trades} sub={t.evaluation.overlapsExcluded(m.overlappingExcluded)} hint={t.glossary.sampleSize} />
                    <Stat label={t.evaluation.winRate} value={m.winRatePct === null ? '—' : `${m.winRatePct.toFixed(0)}%`} hint={t.glossary.winRate} />
                    <Stat
                      label={t.evaluation.sumReturns}
                      value={formatPercentSigned(m.totalReturnPct)}
                      tone={m.totalReturnPct >= 0 ? 'text-up' : 'text-down'}
                    />
                    <Stat
                      label={t.evaluation.buyHold}
                      value={formatPercentSigned(b.result.benchmarkBuyHoldPct)}
                      sub={t.evaluation.sameWindow}
                      hint={t.glossary.buyHold}
                    />
                    <Stat
                      label={t.evaluation.beatBenchmark}
                      value={b.result.benchmarkBuyHoldPct === null ? '—' : beatBenchmark ? t.evaluation.yes : t.evaluation.no}
                      tone={beatBenchmark ? 'text-up' : 'text-down'}
                    />
                  </div>
                  {m.sampleWarning && <p className="mt-2 text-2xs text-warn">{m.sampleWarning}</p>}
                  {b.result.warnings.map((w, j) => (
                    <p key={j} className="mt-1 text-2xs text-ink-faint">
                      · {w}
                    </p>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title={t.evaluation.definitionsTitle}>
        <Table
          head={[
            t.common.strategy,
            t.common.version,
            t.evaluation.assetClasses,
            t.evaluation.timeframes,
            t.evaluation.eligibleRegimes,
            t.evaluation.warmupBars,
            t.evaluation.horizon,
            t.evaluation.parameters,
          ]}
        >
          {STRATEGIES.map((s) => (
            <tr key={s.id}>
              <td className="px-2 py-2 text-xs text-ink">
                {s.name}
                <span className="block text-2xs text-ink-faint">{s.id}</span>
              </td>
              <td className="px-2 py-2 text-2xs text-ink-muted">{s.version}</td>
              <td className="px-2 py-2 text-2xs text-ink-muted">{s.assetClasses.join(', ')}</td>
              <td className="px-2 py-2 text-2xs text-ink-muted">{s.timeframes.join(', ')}</td>
              <td className="px-2 py-2 text-2xs text-ink-muted">{s.eligibleRegimes.join(', ')}</td>
              <td className="num px-2 py-2 text-ink-muted">{s.warmupBars}</td>
              <td className="num px-2 py-2 text-ink-muted">
                {s.evaluationHorizonBars} {t.evaluation.barsSuffix}
              </td>
              <td className="px-2 py-2 text-2xs text-ink-faint">
                {Object.entries(s.parameters)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(', ')}
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <InfoNote>{t.evaluation.footer}</InfoNote>
    </div>
  );
}
