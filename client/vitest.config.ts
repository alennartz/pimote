import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';

export default defineConfig({
  plugins: [svelte()],
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
