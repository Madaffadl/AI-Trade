import './_bootstrap';
import { db } from '../src/lib/db/driver';
import { runRefresh } from '../src/lib/jobs/refresh';

/** Run one refresh cycle and print a human-readable report. */
async function main() {
  const force = process.argv.includes('--force');
  console.log(`Running refresh (force=${force}) ...\n`);
  const s = await runRefresh({ force });

  console.log(`Assets processed : ${s.assetsProcessed}`);
  console.log(`Signals created  : ${s.signalsCreated}`);
  console.log(`Alerts created   : ${s.alertsCreated}`);
  console.log(`Invalidations    : ${s.invalidations}`);
  console.log(`Duration         : ${((s.finishedAtMs - s.startedAtMs) / 1000).toFixed(1)}s`);

  if (s.skipped.length) {
    console.log('\nSkipped (no signal generated):');
    for (const k of s.skipped) console.log(`  - ${k.symbol} ${k.timeframe}: ${k.reason}`);
  }
  if (s.errors.length) {
    console.log('\nErrors:');
    for (const e of s.errors) console.log(`  - ${e.symbol} ${e.timeframe}: ${e.error}`);
  }
  await (await db()).close();
}

main().catch((err) => {
  console.error('Refresh failed:', err);
  process.exit(1);
});
