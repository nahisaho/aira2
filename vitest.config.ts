import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    reporters: ['default', 'json'],
    outputFile: {
      json: 'reports/vitest-report.json',
    },
  },
});
