import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/fixtures/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    reporters: ['default'],
  },
});
