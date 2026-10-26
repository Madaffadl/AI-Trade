/**
 * Test stub for the `server-only` marker package.
 *
 * Outside the Next.js bundler that package throws on import. Vitest runs these
 * modules directly in Node, so it is aliased to this empty module. The real
 * guard still applies to the application build.
 */
export {};
