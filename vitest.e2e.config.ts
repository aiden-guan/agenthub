import { defineConfig } from 'vitest/config';

// `npm run test:e2e`: only the end-to-end suite (design §5.5, §6.7), which the
// default `npm test` leaves out. It has no tests until lane A's step A5.
export default defineConfig({
  test: {
    include: ['packages/e2e/test/**/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
