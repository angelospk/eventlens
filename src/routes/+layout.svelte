<script lang="ts">
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { base } from '$app/paths';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();

	// Registered by hand on purpose: SvelteKit 2 only *updates* an already-registered
	// worker, it does not register one, so without this the app has no offline mode at all.
	onMount(() => {
		if (dev || !('serviceWorker' in navigator)) return;
		navigator.serviceWorker.register(`${base}/service-worker.js`, { scope: `${base}/` });
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
