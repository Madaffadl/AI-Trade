import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/*
 * Flat config (ESLint 9), linted through the ESLint CLI directly — `next lint`
 * was removed in Next 16.
 *
 * eslint-config-next 16 ships NATIVE flat configs, so they are spread in as
 * arrays. The previous version wrapped the legacy names in `FlatCompat`
 * (`compat.extends('next/core-web-vitals', ...)`); against v16 that shim
 * tried to load the flat configs as eslintrc and crashed with "Converting
 * circular structure to JSON" before linting a single file.
 */
const config = [
  { ignores: ['node_modules/**', '.next/**', 'data/**', 'coverage/**', 'next-env.d.ts'] },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];

export default config;
