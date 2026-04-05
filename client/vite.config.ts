import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      manifest: false,
      injectRegister: false,
      outDir: '.svelte-kit/output/client',
      injectManifest: {
        // No precaching — the app requires a network connection.
        // Keep injecting so workbox compiles the SW, but match nothing.
        globPatterns: [],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  build: {
    // The CodeMirror + highlight.js lazy chunk exceeds 500KB but is only
    // loaded on demand when the extension editor dialog opens.
    chunkSizeWarningLimit: 750,
  },
  server: {
    host: true, // bind to 0.0.0.0 so LAN and localhost both work
    proxy: {
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
