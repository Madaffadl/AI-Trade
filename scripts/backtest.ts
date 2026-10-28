import './_bootstrap';
import { db } from '../src/lib/db/driver';
import { getAssetBySymbol, loadCandles } from '../src/lib/db/repo';
import { runBacktest } from '../src/lib/evaluation/backtest';
import { STRATEGIES } from '../src/lib/strategies';
import { isTimeframe, type Timeframe } from '../src/lib/market/types';

/**
 * Walk-forward backtest over candles already stored in the database.
 * Usage: npm run backtest -- BTCIDR 4h
 */
async function main() {
  const symbol = process.argv[2] ?? 'BTCIDR';
  const tfArg = process.argv[3] ?? '1d';
  if (!isTimeframe(tfArg)) throw new Error(`Unsupported timeframe: ${tfArg}`);
  const timeframe: Timeframe = tfArg;

  const asset = await getAssetBySymbol(symbol);
  if (!asset) throw new Error(`Unknown asset ${symbol}. Run "npm run scan" first.`);

  const stored = await loadCandles(asset.id, timeframe, 5000);
  const bars = stored.candles.filter((c) => !c.isPartial);
  console.log(`\n${symbol} ${timeframe}: ${bars.length} closed bars stored`);
  if (bars.length > 0) {
    console.log(
      `Range: ${new Date(bars[0]!.openTimeMs).toISOString().slice(0, 10)} -> ${new Date(bars.at(-1)!.openTimeMs).toISOString().slice(0, 10)}`,
    );
  }

  for (const strategy of STRATEGIES) {
    if (!strategy.timeframes.includes(timeframe) || !strategy.assetClasses.includes(asset.assetClass)) continue;
    const r = runBacktest({ strategy, bars, timeframe, assetClass: asset.assetClass });
    const m = r.metrics;
    console.log(`\n=== ${strategy.id}@${strategy.version} ===`);
    console.log(`Bars tested        : ${r.barsTested}`);
    console.log(`Signals generated  : ${r.signalsGenerated}`);
    console.log(`Independent trades : ${m.trades} (excluded ${m.overlappingExcluded} overlapping)`);
    if (m.trades > 0) {
      console.log(`Win rate           : ${m.winRatePct?.toFixed(1)}%  (${m.wins}W / ${m.losses}L)`);
      console.log(`Expectancy / trade : ${m.expectancyPct?.toFixed(3)}% net`);
      console.log(`Expectancy (R)     : ${m.expectancyR?.toFixed(3) ?? 'n/a'}`);
      console.log(`Profit factor      : ${m.profitFactor?.toFixed(2) ?? 'undefined (no losses)'}`);
      console.log(`Max drawdown       : ${m.maxDrawdownPct?.toFixed(2)}% (sum of trade returns)`);
      console.log(`Total (sum) return : ${m.totalReturnPct.toFixed(2)}%`);
    }
    console.log(`Buy & hold benchmark: ${r.benchmarkBuyHoldPct?.toFixed(2) ?? 'n/a'}%`);
    if (m.sampleWarning) console.log(`! ${m.sampleWarning}`);
    for (const w of r.warnings) console.log(`! ${w}`);
  }

  await (await db()).close();
}

main().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
