import './_bootstrap';
import { db, migrate } from '../src/lib/db/driver';
import { runValidation } from '../src/lib/evaluation/validate';

/**
 * Backfill Indodax history and validate every strategy x timeframe.
 * `--no-backfill` validates on the candles already stored.
 */
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`);
const day = (ms: number | null) => (ms === null ? '—' : new Date(ms).toISOString().slice(0, 10));

async function main() {
  await migrate();
  const started = Date.now();
  console.log('Validating on Indodax history ...');
  const rows = await runValidation({ backfill: !process.argv.includes('--no-backfill'), log: (l) => console.log(l) });
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  for (const v of rows) {
    const is = v.inSample;
    const oos = v.outOfSample;
    console.log(`${v.strategy_id} ${v.timeframe}  ->  ${v.label.toUpperCase()}${v.unmet.length ? `  (${v.unmet.join(', ')})` : ''}`);
    console.log(`   period ${day(v.period_from_ms)} .. ${day(v.period_to_ms)}, out-of-sample from ${day(v.split_at_ms)}, ${v.pairs} pairs`);
    console.log(`   strategy signals ${v.signals}, rejected by plan rules: ${JSON.stringify(v.rejected)}`);
    console.log(`   in-sample    : ${is.trades} trades, win ${is.winRatePct?.toFixed(0) ?? '—'}%, expectancy ${pct(is.expectancyPct)} net, PF ${is.profitFactor?.toFixed(2) ?? '—'}`);
    console.log(`   out-of-sample: ${oos.trades} trades, win ${oos.winRatePct?.toFixed(0) ?? '—'}%, expectancy ${pct(oos.expectancyPct)} net, PF ${oos.profitFactor?.toFixed(2) ?? '—'}, max DD ${oos.maxDrawdownPct?.toFixed(2) ?? '—'}%`);
    console.log(`   benchmarks   : random entries ${pct(v.random_expectancy_pct)} per trade (${v.random_trades}), buy & hold ${pct(v.buy_hold_pct)} over the out-of-sample period`);
  }
  await (await db()).close();
}

main().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
