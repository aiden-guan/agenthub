import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The end-to-end suite runs only with `npm run test:e2e` (vitest.e2e.config.ts).
    exclude: [...configDefaults.exclude, 'packages/e2e/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
