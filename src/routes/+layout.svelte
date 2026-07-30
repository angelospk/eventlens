<script lang="ts">
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { base } from '$app/paths';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();

	// A new version is ready but is not allowed to take over on its own: swapping the code
	// under a page that is mid-upload would be the worst possible moment. So the app says
	// so and waits to be told, which also means an installed app on a phone can update
	// without being force-quit first.
	let waiting = $state<ServiceWorker | null>(null);
	let reloading = false;

	function applyUpdate() {
		if (!waiting) return;
		waiting.postMessage({ type: 'skip-waiting' });
	}

	// Registered by hand on purpose: SvelteKit 2 only *updates* an already-registered
	// worker, it does not register one, so without this the app has no offline mode at all.
	onMount(() => {
		if (dev || !('serviceWorker' in navigator)) return;

		navigator.serviceWorker.addEventListener('controllerchange', () => {
			// The new worker took over. One reload and the page is running the new code.
			if (reloading) return;
			reloading = true;
			location.reload();
		});

		navigator.serviceWorker
			.register(`${base}/service-worker.js`, { scope: `${base}/` })
			.then((reg) => {
				const offer = (sw: ServiceWorker | null) => {
					if (sw && navigator.serviceWorker.controller) waiting = sw;
				};
				offer(reg.waiting);
				reg.addEventListener('updatefound', () => {
					const sw = reg.installing;
					sw?.addEventListener('statechange', () => {
						if (sw.state === 'installed') offer(sw);
					});
				});
				// An installed app can stay open for days. Without this it would only look
				// for a new version when it happened to be restarted.
				setInterval(() => reg.update().catch(() => {}), 15 * 60 * 1000);
			})
			.catch(() => {
				// No service worker means no offline mode, which is worth nothing breaking over.
			});
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{#if waiting}
	<div class="update-bar">
		<span>Υπάρχει νέα έκδοση.</span>
		<button onclick={applyUpdate}>Ανανέωση</button>
	</div>
{/if}

{@render children()}

<style>
	.update-bar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 1000;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.9rem;
		padding: 0.7rem 1rem calc(0.7rem + env(safe-area-inset-bottom));
		background: var(--accent-strong, #4f52e0);
		color: #fff;
		font-size: 0.9rem;
	}

	.update-bar button {
		font: inherit;
		font-weight: 600;
		color: var(--accent-strong, #4f52e0);
		background: #fff;
		border: 0;
		border-radius: 999px;
		padding: 0.35rem 0.9rem;
		cursor: pointer;
	}
</style>
