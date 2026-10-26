import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  /*
   * Compile JSX for tests explicitly.
   *
   * tsconfig.json sets `"jsx": "preserve"` because Next.js does its own JSX
   * transform, and that must stay. Vitest 3 (Vite 5/esbuild) transformed JSX
   * regardless; Vitest 5 runs on Vite 8, whose Oxc transformer HONOURS the
   * tsconfig and leaves JSX untouched — so any test importing a `.tsx` module
   * failed with "Failed to parse source for import analysis". Setting it here
   * scopes the change to the test runner and leaves the Next build alone.
   */
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws when imported outside the Next bundler; tests run
      // these modules directly in Node, so it resolves to an empty stub here.
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
});
