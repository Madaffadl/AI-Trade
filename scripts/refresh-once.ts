import './_bootstrap';
import { db, migrate } from '../src/lib/db/driver';
import { runRefresh } from '../src/lib/jobs/refresh';

/** Run one refresh cycle (Indodax scan + live check + position review) and print a short report. */
async function main() {
  await migrate();
  console.log('Running refresh ...\n');
  const s = await runRefresh({ waitMs: 30_000 });
  console.log(`Decision        : ${s.decision ?? '—'}`);
  console.log(`Setups          : ${s.setups}`);
  console.log(`Alerts created  : ${s.alertsCreated}`);
  console.log(`Signals expired : ${s.signalsExpired}`);
  console.log(`Duration        : ${((s.finishedAtMs - s.startedAtMs) / 1000).toFixed(1)}s`);
  if (s.error) console.log(`Error           : ${s.error}`);
  await (await db()).close();
}

main().catch((err) => {
  console.error('Refresh failed:', err);
  process.exit(1);
});
