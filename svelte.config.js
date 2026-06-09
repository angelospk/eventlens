import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const base = process.env.BASE_PATH ?? '';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({ fallback: 'index.html' }),
		paths: { base },
		// '/manager' and '/wall' are not linked from the root, so they must be listed
		// explicitly, otherwise GitHub Pages 404s a direct hit (no prerendered file).
		prerender: { entries: ['*', '/manager', '/wall'] }
	}
};

export default config;
