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
				globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2}'],
			},
			devOptions: {
				enabled: false
			}
		})
	],
	server: {
		host: true, // bind to 0.0.0.0 so LAN and localhost both work
		proxy: {
			'/ws': {
				target: 'ws://localhost:3000',
				ws: true
			}
		}
	}
});
