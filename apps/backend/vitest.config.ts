import { defineConfig } from 'vitest/config';

/** Unit tests: fast, no network, no Docker. Co-located with source as *.test.ts. */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
