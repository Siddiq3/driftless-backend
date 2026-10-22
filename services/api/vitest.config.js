import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globalSetup: ['test/global-setup.js'], testTimeout: 20_000, fileParallelism: false },
});
