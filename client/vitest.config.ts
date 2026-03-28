import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '$lib': path.resolve(__dirname, 'src/lib'),
      '@pimote/shared': path.resolve(__dirname, '../shared/dist/index.js'),
    },
  },
});
