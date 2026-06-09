<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { base } from '$app/paths';
  import { config } from '$lib/config';
  import { fetchWallPhotos, loadSponsors } from '$lib/wall-client';
  import { buildPlaylist } from '$lib/playlist';
  import type { Sponsor, Slide } from '$lib/types';

  // Playback tuning (ms). Sponsors interleave after every `sponsorEvery` photos.
  const OPTS = { photoDurationMs: 6000, sponsorEvery: 4, defaultSponsorMs: 5000 };
  const POLL_MS = 30000;

  // Local YYYY-MM-DD (avoids UTC off-by-one), matching the manager page.
  function today(): string {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  let slides = $state<Slide[]>([]);
  let index = $state(0);
  let sponsors: Sponsor[] = [];
  let date = today();

  // Keys of images that failed to load; skipped during advance so a broken URL never sticks.
  const failed = new Set<string>();

  let advanceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let inflight: AbortController | null = null;

  let current = $derived(slides[index]);

  // sponsors.json image URLs may be: a full URL (http(s):// or protocol-relative //) — used as-is;
  // or a root-absolute path ("/logo.png") — rewritten under the SvelteKit base path so it resolves
  // on subpath deployments (e.g. GitHub Pages). Relative paths are left untouched.
  function normalizeSponsorUrls(list: Sponsor[]): Sponsor[] {
    return list.map((s) => {
      if (s.type !== 'image' || !s.imageUrl) return s;
      const url = s.imageUrl;
      const isAbsolute = /^https?:\/\//.test(url) || url.startsWith('//');
      if (!isAbsolute && url.startsWith('/')) return { ...s, imageUrl: `${base}${url}` };
      return s;
    });
  }

  function clearAdvance() {
    if (advanceTimer !== null) { clearTimeout(advanceTimer); advanceTimer = null; }
  }

  // Advance to the next slide whose image hasn't failed, wrapping around. If every slide is
  // unplayable, stop auto-advancing and wait for the next poll to bring fresh slides.
  function next() {
    if (slides.length === 0) { clearAdvance(); return; }
    for (let step = 1; step <= slides.length; step++) {
      const i = (index + step) % slides.length;
      if (!failed.has(slides[i].key)) { index = i; scheduleAdvance(); return; }
    }
    clearAdvance(); // all failed
  }

  function scheduleAdvance() {
    clearAdvance();
    const cur = slides[index];
    if (!cur) return;
    advanceTimer = setTimeout(next, cur.durationMs);
  }

  // Swap in a freshly built playlist while keeping the viewer on the same slide where possible.
  function applyPlaylist(nextSlides: Slide[]) {
    const curKey = slides[index]?.key;
    slides = nextSlides;
    if (slides.length === 0) {
      index = 0;
      clearAdvance();
      return;
    }
    const found = slides.findIndex((s) => s.key === curKey);
    index = found >= 0 ? found : Math.min(index, slides.length - 1);
    // Only (re)start the timer if it was stopped (initial load, or recovered from empty/all-failed);
    // a healthy running timer is left alone so polling doesn't stretch the current slide.
    if (advanceTimer === null) scheduleAdvance();
  }

  async function refresh() {
    inflight?.abort();
    inflight = new AbortController();
    try {
      const photos = await fetchWallPhotos(
        { workerUrl: config.workerUrl, fetchImpl: (u, o) => fetch(u, { ...o, signal: inflight!.signal }) },
        date
      );
      applyPlaylist(buildPlaylist(photos, sponsors, OPTS));
    } catch {
      // Network/abort error: keep the current playlist, try again next interval.
    }
  }

  function onImgError(key: string) {
    failed.add(key);
    // If the broken image is the one on screen, jump off it immediately.
    if (slides[index]?.key === key) next();
  }

  onMount(async () => {
    if (!browser) return;
    const qd = new URLSearchParams(window.location.search).get('date');
    if (qd && /^\d{4}-\d{2}-\d{2}$/.test(qd)) date = qd;
    sponsors = normalizeSponsorUrls(await loadSponsors(`${base}/sponsors.json`));
    await refresh();
    pollTimer = setInterval(refresh, POLL_MS);
  });

  onDestroy(() => {
    clearAdvance();
    if (pollTimer !== null) clearInterval(pollTimer);
    inflight?.abort();
  });
</script>

<svelte:head>
  <title>EventLens — Wall</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="wall">
  {#if !current}
    <p class="placeholder">Σε λίγο…</p>
  {:else if current.kind === 'photo' || current.kind === 'image'}
    <img class="full" src={current.src} alt="" onerror={() => onImgError(current.key)} />
  {:else}
    <p class="message">{current.text}</p>
  {/if}
</div>

<style>
  :global(body) { margin: 0; }

  .wall {
    position: fixed;
    inset: 0;
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .full {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  .placeholder,
  .message {
    color: #fff;
    text-align: center;
    padding: 5vw;
    font-family: system-ui, sans-serif;
  }

  .placeholder { opacity: 0.5; font-size: 4vw; }

  .message {
    font-size: 5vw;
    font-weight: 600;
    line-height: 1.3;
    max-width: 80vw;
  }
</style>
