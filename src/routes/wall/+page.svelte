<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { base } from '$app/paths';
  import { config } from '$lib/config';
  import { fetchWall, loadSponsors } from '$lib/wall-client';
  import { buildPlaylist } from '$lib/playlist';
  import { today, isValidDate } from '$lib/date';
  import type { Sponsor, Slide } from '$lib/types';

  // Playback tuning (ms). Sponsors interleave after every `sponsorEvery` photos.
  const OPTS = { photoDurationMs: 6000, sponsorEvery: 4, defaultSponsorMs: 5000 };
  const POLL_MS = 30000;

  let slides = $state<Slide[]>([]);
  let index = $state(0);
  let sponsors: Sponsor[] = [];
  let date = today();
  let pinnedDate = false; // true when ?date= was given, so the rollover check stays off
  let controlsVisible = $state(true);
  let isFullscreen = $state(false);

  // Keys of images that failed to load; skipped during advance so a broken URL never sticks.
  const failed = new Set<string>();

  let advanceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let inflight: AbortController | null = null;

  let current = $derived(slides[index]);
  // Warm the browser cache for whatever comes next so the swap is instant on the projector.
  let nextSrc = $derived(slides.length > 1 ? slides[(index + 1) % slides.length]?.src : undefined);

  // sponsors.json image URLs may be: a full URL (http(s):// or protocol-relative //) - used as-is;
  // or a root-absolute path ("/logo.png") - rewritten under the SvelteKit base path so it resolves
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
    // A wall left running overnight follows the same night boundary as the uploads, so it
    // keeps showing tonight's photographs through the small hours and only turns over once
    // the night is genuinely finished. An explicit ?date= stays pinned.
    if (!pinnedDate) {
      const now = today();
      if (now !== date) {
        date = now;
        failed.clear();
      }
    }

    inflight?.abort();
    inflight = new AbortController();
    const signal = inflight.signal;
    try {
      const res = await fetchWall(
        { workerUrl: config.workerUrl, fetchImpl: (u, o) => fetch(u, { ...o, signal }) },
        date
      );
      applyPlaylist(buildPlaylist(res.photos, sponsors, OPTS));
    } catch {
      // Network/abort error: keep the current playlist, try again next interval.
    }
  }

  function onImgError(key: string) {
    failed.add(key);
    // If the broken image is the one on screen, jump off it immediately.
    if (slides[index]?.key === key) next();
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // Some browsers refuse without a direct gesture; nothing useful to show the operator.
    }
  }

  function wake() {
    controlsVisible = true;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (controlsVisible = false), 3000);
  }

  const onFs = () => (isFullscreen = Boolean(document.fullscreenElement));

  // Deliberately not an async callback: Svelte ignores the cleanup function returned by an
  // async onMount, which would leak the fullscreen listener on every navigation.
  onMount(() => {
    if (!browser) return;
    const qd = new URLSearchParams(window.location.search).get('date');
    if (qd && isValidDate(qd)) { date = qd; pinnedDate = true; }
    document.addEventListener('fullscreenchange', onFs);
    wake();

    void (async () => {
      // Nothing before the timer is allowed to prevent it from being set. This screen runs
      // unattended on a projector all night; a stall here is a black screen nobody fixes.
      try {
        sponsors = normalizeSponsorUrls(await loadSponsors(`${base}/sponsors.json`));
      } catch {
        sponsors = [];
      }
      try {
        await refresh();
      } finally {
        pollTimer = setInterval(refresh, POLL_MS);
      }
    })();
  });

  onDestroy(() => {
    clearAdvance();
    if (pollTimer !== null) clearInterval(pollTimer);
    if (idleTimer !== null) clearTimeout(idleTimer);
    inflight?.abort();
    if (browser) document.removeEventListener('fullscreenchange', onFs);
  });
</script>

<svelte:head>
  <title>EventLens - Wall</title>
  <meta name="robots" content="noindex" />
  {#if nextSrc}
    <link rel="preload" as="image" href={nextSrc} />
  {/if}
</svelte:head>

<div class="wall" role="presentation" onmousemove={wake} ontouchstart={wake}>
  {#if !current}
    <p class="placeholder">Σε λίγο</p>
  {:else if current.kind === 'photo' || current.kind === 'image'}
    {#key current.key}
      <img class="full" src={current.src} alt="" onerror={() => onImgError(current.key)} />
    {/key}
  {:else}
    {#key current.key}
      <p class="message">{current.text}</p>
    {/key}
  {/if}

  <button class="fs" class:hidden={!controlsVisible} onclick={toggleFullscreen}>
    {isFullscreen ? 'Έξοδος από πλήρη οθόνη' : 'Πλήρης οθόνη'}
  </button>
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
    animation: fade 0.6s ease;
  }

  @keyframes fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .placeholder,
  .message {
    color: #fff;
    text-align: center;
    padding: 5vw;
    font-family: system-ui, sans-serif;
    animation: fade 0.6s ease;
  }

  .placeholder { opacity: 0.5; font-size: 4vw; }

  .message {
    font-size: 5vw;
    font-weight: 600;
    line-height: 1.3;
    max-width: 80vw;
  }

  .fs {
    position: absolute;
    bottom: 2vmin;
    right: 2vmin;
    font: inherit;
    font-size: 0.85rem;
    color: #fff;
    background: rgb(255 255 255 / 0.12);
    border: 1px solid rgb(255 255 255 / 0.2);
    border-radius: 999px;
    padding: 0.5rem 1rem;
    cursor: pointer;
    transition: opacity 0.4s ease;
  }

  .fs.hidden {
    opacity: 0;
    pointer-events: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .full,
    .placeholder,
    .message {
      animation: none;
    }
  }
</style>
