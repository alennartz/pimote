import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({
      fallback: 'index.html',
    }),
    alias: {
      '@pimote/shared': '../shared/dist/index.js',
    },
  },
  vitePlugin: {
    dynamicCompileOptions: ({ filename }) => (filename.includes('node_modules') ? undefined : { runes: true }),
  },
};

export default config;
