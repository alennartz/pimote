import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		VitePWA({
			strategies: 'generateSW',
			registerType: 'autoUpdate',
			manifest: false,
			outDir: '.svelte-kit/output/client',
			workbox: {
				globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2}'],
				navigateFallback: '/index.html',
				runtimeCaching: [
					{
						urlPattern: /^https?:\/\/[^/]+\/$/,
						handler: 'NetworkFirst',
						options: {
							cacheName: 'app-shell',
							expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 7 }
						}
					},
					{
						urlPattern: /\.(js|css|svg|png|woff2?)$/,
						handler: 'StaleWhileRevalidate',
						options: {
							cacheName: 'static-assets',
							expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 }
						}
					},
					{
						urlPattern: /\/api\//,
						handler: 'NetworkOnly'
					},
					{
						urlPattern: /\/ws/,
						handler: 'NetworkOnly'
					}
				]
			},
			devOptions: {
				enabled: false
			}
		})
	],
	server: {
		proxy: {
			'/ws': {
				target: 'ws://localhost:3001',
				ws: true
			}
		}
	}
});
