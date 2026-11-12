import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'api',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    // Serial on purpose; test/setup.ts takes an advisory lock so an overlap fails loudly instead of corrupting data.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
