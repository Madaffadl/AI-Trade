import './_bootstrap';
import { db } from '../src/lib/db/driver';
import { evaluateStoredSignals, forwardPerformanceByStrategy } from '../src/lib/evaluation/forward';

async function main() {
  console.log('Evaluating stored signals against subsequent candles...\n');
  const summary = await evaluateStoredSignals();
  console.log(`Evaluated   : ${summary.evaluated}`);
  console.log(`Pending     : ${summary.stillPending} (horizon not yet elapsed)`);
  console.log(`Unevaluable : ${summary.unevaluable}\n`);

  for (const p of await forwardPerformanceByStrategy()) {
    const m = p.metrics;
    console.log(`=== ${p.strategyId} ===`);
    console.log(`  trades ${m.trades} · wins ${m.wins} · losses ${m.losses}`);
    if (m.trades > 0) {
      console.log(`  win rate ${m.winRatePct?.toFixed(1)}% · expectancy ${m.expectancyPct?.toFixed(3)}% net`);
      console.log(`  profit factor ${m.profitFactor?.toFixed(2) ?? 'undefined'} · max DD ${m.maxDrawdownPct?.toFixed(2)}%`);
    }
    if (m.sampleWarning) console.log(`  ! ${m.sampleWarning}`);
  }

  await (await db()).close();
}

main().catch((err) => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});
