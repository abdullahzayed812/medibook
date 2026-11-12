import { defineConfig } from 'vitest/config';

/**
 * Integration tests: run against real MySQL and Redis (see docs/development/TESTING_GUIDELINES.md).
 * Files run sequentially because they share the same database and Redis instance.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/support/global-setup.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
