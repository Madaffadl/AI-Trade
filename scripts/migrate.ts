import './_bootstrap';
import { db, migrate } from '../src/lib/db/driver';
import { env } from '../src/lib/config/env';

async function main() {
  const target = env().DATABASE_URL ? 'PostgreSQL' : `SQLite (${env().SQLITE_PATH})`;
  console.log(`Applying schema to ${target} ...`);
  const result = await migrate();
  console.log(`Applied ${result.statements} statements on ${result.dialect}.`);
  for (const id of result.applied) console.log(`  + migration ${id}`);
  await (await db()).close();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
