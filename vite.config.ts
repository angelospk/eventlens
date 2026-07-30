import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The HEIC decoder is three megabytes of WebAssembly that only iPhone-native files need.
// It is imported dynamically inside the image worker so that a night of JPEGs never pays
// for it, and this keeps that promise true in the build output.
const splitOutHeic = {
	// A stable, recognisable chunk name is what lets the service worker leave it out of the
	// offline precache.
	manualChunks(id: string) {
		if (id.includes('heic-to')) return 'heic-decoder';
	}
};

export default defineConfig({
	plugins: [sveltekit()],
	worker: {
		// Vite builds workers as IIFE by default, and an IIFE cannot code-split: every
		// dynamic import inside the worker gets inlined, which silently turned the decoder
		// into a three megabyte download for everyone. The worker is already created with
		// `{ type: 'module' }`, so ES output costs nothing and restores the split.
		format: 'es',
		rollupOptions: { output: splitOutHeic }
	},
	build: {
		rollupOptions: { output: splitOutHeic }
	}
});
