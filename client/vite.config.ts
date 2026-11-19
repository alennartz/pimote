import { resolve } from 'node:path';
import { build as bundleWithEsbuild } from 'esbuild';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig, type Plugin } from 'vite';

const themeEntries = {
  '/pwa/theme-bootstrap.js': resolve('src/theme-bootstrap-entry.ts'),
  '/pwa/theme-bridge.js': resolve('src/theme-bridge-entry.ts'),
} as const;

async function bundleBootstrap(): Promise<string> {
  const result = await bundleWithEsbuild({
    absWorkingDir: process.cwd(),
    entryPoints: [themeEntries['/pwa/theme-bootstrap.js']],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    alias: { '@pimote/shared': resolve('../shared/dist/index.js') },
    define: { $state: 'identityState' },
    banner: { js: 'const identityState = (value) => value;' },
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

function themeAssetEntries(): Plugin {
  return {
    name: 'pimote-theme-asset-entries',
    async buildStart() {
      this.emitFile({ type: 'asset', fileName: 'pwa/theme-bootstrap.js', source: await bundleBootstrap() });
      this.emitFile({ type: 'chunk', id: themeEntries['/pwa/theme-bridge.js'], fileName: 'pwa/theme-bridge.js' });
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url?.split('?', 1)[0];
        const id = pathname ? themeEntries[pathname as keyof typeof themeEntries] : undefined;
        if (!id) {
          next();
          return;
        }
        try {
          const code = pathname === '/pwa/theme-bootstrap.js' ? await bundleBootstrap() : (await server.transformRequest(id))?.code;
          if (!code) {
            next();
            return;
          }
          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/javascript');
          response.end(code);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [
    themeAssetEntries(),
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
