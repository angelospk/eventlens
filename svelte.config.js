import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const base = process.env.BASE_PATH ?? '';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({ fallback: 'index.html' }),
		paths: { base },
		// '/manager' is not linked from the root, so it must be listed explicitly,
		// otherwise GitHub Pages 404s a direct hit to /manager (no prerendered file).
		prerender: { entries: ['*', '/manager'] }
	}
};

export default config;
