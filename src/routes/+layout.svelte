<script lang="ts">
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { uploads } from '$lib/uploads.svelte';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();

	// A new version is ready but is not allowed to take over on its own: swapping the code
	// under a page that is mid-upload would be the worst possible moment. So the app says
	// so and waits to be told, which also means an installed app on a phone can update
	// without being force-quit first.
	let waiting = $state<ServiceWorker | null>(null);
	let reloading = false;

	// The upload screen shows all of this in full, so the strip would only be in its way.
	const onUploadScreen = $derived(page.url.pathname.replace(/\/$/, '') === base.replace(/\/$/, ''));
	const queued = $derived(uploads.items.filter((i) => i.status !== 'error').length);
	const failedCount = $derived(uploads.items.filter((i) => i.status === 'error').length);
	// Shown while there is anything to report, so leaving the upload screen no longer means
	// losing sight of a night's photographs going up.
	const showStrip = $derived(!onUploadScreen && uploads.ready && (queued > 0 || failedCount > 0));
	const busyName = $derived(uploads.items.find((i) => i.id === uploads.activeId)?.originalName ?? '');

	function applyUpdate() {
		if (!waiting || blockUpdate) return;
		waiting.postMessage({ type: 'skip-waiting' });
	}

	// Applying an update reloads the page. With an in-memory queue that means losing every
	// photograph still in it, so the offer waits until the queue is empty.
	const blockUpdate = $derived(uploads.ephemeral && uploads.items.length > 0);

	// Registered by hand on purpose: SvelteKit 2 only *updates* an already-registered
	// worker, it does not register one, so without this the app has no offline mode at all.
	onMount(() => {
		// Started here rather than per page, so photographs left over from a previous session
		// resume no matter which screen the app was opened on.
		if (uploads.session.restore()) uploads.start();

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

{#if showStrip}
	<a class="upload-strip" href="{base}/">
		<span class="bar" aria-hidden="true"><span class="fill" class:moving={!!uploads.activeId}></span></span>
		<span class="text">
			{#if uploads.activeId}
				Ανεβάζει {busyName || 'φωτογραφία'}
			{:else if uploads.struggling}
				Περιμένει δίκτυο
			{:else}
				Σε ουρά
			{/if}
		</span>
		<span class="counts">
			{uploads.completed} ✓ · {queued} σε ουρά{#if failedCount} · {failedCount} ✗{/if}
		</span>
	</a>
{/if}

{#if waiting}
	<div class="update-bar">
		{#if blockUpdate}
			<span>Νέα έκδοση — μόλις ανέβουν οι φωτογραφίες.</span>
		{:else}
			<span>Υπάρχει νέα έκδοση.</span>
			<button onclick={applyUpdate}>Ανανέωση</button>
		{/if}
	</div>
{/if}

{@render children()}

<style>
	.upload-strip {
		position: fixed;
		left: 0;
		right: 0;
		top: 0;
		z-index: 900;
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.5rem 0.9rem;
		background: var(--surface-2, #16171f);
		border-bottom: 1px solid var(--line, #262833);
		color: var(--text, #e8e9f0);
		font-size: 0.8rem;
		text-decoration: none;
	}

	.upload-strip .text {
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.upload-strip .counts {
		margin-left: auto;
		white-space: nowrap;
		color: var(--muted, #9a9db0);
	}

	.upload-strip .bar {
		flex: none;
		width: 2.2rem;
		height: 0.3rem;
		border-radius: 999px;
		background: var(--line, #262833);
		overflow: hidden;
	}

	.upload-strip .fill {
		display: block;
		height: 100%;
		width: 40%;
		border-radius: 999px;
		background: var(--accent-strong, #4f52e0);
	}

	.upload-strip .fill.moving {
		animation: slide 1.2s ease-in-out infinite;
	}

	@keyframes slide {
		0% { transform: translateX(-100%); }
		100% { transform: translateX(250%); }
	}

	/* A photographer who has turned motion down should not get a looping bar. */
	@media (prefers-reduced-motion: reduce) {
		.upload-strip .fill.moving { animation: none; }
	}

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
