import './_bootstrap';
import { db, migrate } from '../src/lib/db/driver';
import { upsertExchange } from '../src/lib/db/repo';
import { upsertStrategyDefinition } from '../src/lib/signals/repo';
import { STRATEGIES } from '../src/lib/strategies';

/**
 * Seeds reference data only: the Indodax exchange and the strategy
 * definitions. It seeds NO market data and no assets - the scan universe is
 * built from Indodax's live pair list by `npm run scan` / the worker.
 */
async function main() {
  await migrate();

  await upsertExchange({
    id: 'INDODAX',
    name: 'Indodax (Indonesian crypto exchange, IDR pairs)',
    asset_class: 'crypto',
    country: 'ID',
    timezone: 'Asia/Jakarta',
    continuous: true,
  });
  console.log('seeded exchange INDODAX');

  for (const strategy of STRATEGIES) {
    await upsertStrategyDefinition({
      id: strategy.id,
      version: strategy.version,
      name: strategy.name,
      description: strategy.description,
      assetClasses: strategy.assetClasses,
      timeframes: strategy.timeframes,
      parameters: strategy.parameters,
      warmupBars: strategy.warmupBars,
    });
    console.log(`registered strategy ${strategy.id}@${strategy.version}`);
  }

  console.log('\nSeed complete. Reference data only - no prices were written.');
  await (await db()).close();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
