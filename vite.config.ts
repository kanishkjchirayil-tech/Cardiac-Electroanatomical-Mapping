import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    rolldownOptions: { input: { main: 'index.html', selftest: 'selftest.html' } },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
