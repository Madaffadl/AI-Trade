/**
 * Loads .env.local / .env for standalone scripts (tsx), which do not get
 * Next.js's automatic env loading. Secrets stay in the process environment and
 * are never written anywhere.
 */
import { config } from 'dotenv';
import { existsSync } from 'node:fs';

for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) config({ path: file, quiet: true });
}
