<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { config } from '$lib/config';
  import { today, formatGreek, isValidDate } from '$lib/date';
  import { fetchWall } from '$lib/wall-client';
  import type { WallPhoto } from '$lib/types';

  // The public page for guests, and the one that gets embedded in ardasfestival.gr. It is
  // deliberately plain: a date and the photographs. Everything else (status chips, counts,
  // a second heading repeating the word "photos") is noise inside a host page that already
  // has its own header and its own title for the section.
  //
  // Read-only, no passcode, and cheap: the Worker response is edge-cached, so a full venue
  // refreshing this costs very few database reads.
  const POLL_MS = 20000;

  let date = $state(today());
  let photos = $state<WallPhoto[]>([]);
  let loaded = $state(false);
  let lightboxIndex = $state<number | null>(null);

  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight: AbortController | null = null;

  // Newest first: on a live page the last photo taken is the one people want to see.
  const ordered = $derived([...photos].reverse());
  const heading = $derived(formatGreek(date));

  async function refresh() {
    inflight?.abort();
    inflight = new AbortController();
    const signal = inflight.signal;
    try {
      const res = await fetchWall(
        { workerUrl: config.workerUrl, fetchImpl: (u, o) => fetch(u, { ...o, signal }) },
        date
      );
      photos = res.photos;
    } catch {
      // Keep whatever is already on screen and try again on the next tick.
    } finally {
      loaded = true;
    }
  }

  // Returns focus to the thumbnail when the lightbox closes, so keyboard users are not
  // dumped at the top of the document.
  let lastTrigger: HTMLElement | null = null;

  function autofocus(node: HTMLElement) {
    node.focus();
    return {
      destroy() {
        lastTrigger?.focus();
        lastTrigger = null;
      }
    };
  }

  function openAt(i: number, e: MouseEvent) {
    lastTrigger = e.currentTarget as HTMLElement;
    lightboxIndex = i;
  }

  function move(step: number) {
    if (lightboxIndex === null || ordered.length === 0) return;
    lightboxIndex = (lightboxIndex + step + ordered.length) % ordered.length;
  }

  function onKey(e: KeyboardEvent) {
    if (lightboxIndex === null) return;
    if (e.key === 'Escape') lightboxIndex = null;
    if (e.key === 'ArrowRight') move(1);
    if (e.key === 'ArrowLeft') move(-1);
  }

  // When embedded, tell the host page how tall this content is. An iframe cannot size
  // itself, so without this the gallery would be cut off at whatever fixed height the host
  // guessed, and it grows every time a photo is approved.
  let observer: ResizeObserver | null = null;

  function reportHeight() {
    if (window.parent === window) return;
    const h = Math.ceil(document.documentElement.scrollHeight);
    window.parent.postMessage({ type: 'eventlens:height', height: h }, '*');
  }

  onMount(() => {
    if (!browser) return;
    const qd = new URLSearchParams(location.search).get('date');
    if (qd && isValidDate(qd)) date = qd;
    refresh();
    timer = setInterval(refresh, POLL_MS);
    // Come back from a backgrounded tab with fresh photos rather than a stale grid.
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);

    observer = new ResizeObserver(reportHeight);
    observer.observe(document.documentElement);
    // Images settle after the observer fires, so report again once they have loaded.
    window.addEventListener('load', reportHeight);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('load', reportHeight);
    };
  });

  onDestroy(() => {
    if (timer !== null) clearInterval(timer);
    observer?.disconnect();
    inflight?.abort();
  });
</script>

<svelte:head>
  <title>{heading}</title>
  <meta name="description" content="Οι φωτογραφίες της βραδιάς." />
</svelte:head>

<svelte:window onkeydown={onKey} />

<div class="page">
  <h1>{heading}</h1>

  {#if !loaded}
    <div class="grid" aria-hidden="true">
      {#each Array(8) as _, i (i)}
        <div class="ph" style="height:{170 + (i % 3) * 70}px"></div>
      {/each}
    </div>
  {:else if ordered.length === 0}
    <p class="empty">Δεν υπάρχουν ακόμα φωτογραφίες.</p>
  {:else}
    <div class="grid">
      {#each ordered as p, i (p.id)}
        <button class="cell" onclick={(e) => openAt(i, e)} aria-label="Άνοιγμα φωτογραφίας">
          <img src={p.public_url} alt="" loading="lazy" decoding="async" onload={reportHeight} />
        </button>
      {/each}
    </div>
  {/if}
</div>

{#if lightboxIndex !== null && ordered[lightboxIndex]}
  <div class="lightbox" role="dialog" aria-modal="true" aria-label="Φωτογραφία">
    <img src={ordered[lightboxIndex].public_url} alt="" />
    <button class="nav prev" onclick={() => move(-1)} aria-label="Προηγούμενη">‹</button>
    <button class="nav next" onclick={() => move(1)} aria-label="Επόμενη">›</button>
    <button class="close" onclick={() => (lightboxIndex = null)} aria-label="Κλείσιμο"
            use:autofocus>×</button>
  </div>
{/if}

<style>
  /* This page is light while the rest of the app is dark, because it is the only one that
     gets embedded in ardasfestival.gr. Its palette is taken from that site: white ground,
     black Poppins headings, grey secondary text, and photographs butted together with
     square corners. A dark panel dropped into a white page would read as a foreign object. */
  :global(html),
  :global(body) {
    background: #fff;
    color: #8a8a8a;
    /* Poppins to match the host. It has no Greek glyphs, so Greek falls through to the
       system face exactly as it does on ardasfestival.gr itself. */
    font-family: 'Poppins', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }

  .page {
    max-width: 1140px;
    margin: 0 auto;
    padding: clamp(1.25rem, 4vw, 2.5rem) clamp(0.75rem, 3vw, 1.5rem) 3rem;
  }

  h1 {
    margin: 0 0 clamp(1rem, 3vw, 1.75rem);
    color: #000;
    font-weight: 600;
    font-size: clamp(1.6rem, 5vw, 2.5rem);
    line-height: 1.15;
    letter-spacing: -0.01em;
  }

  /* Columns rather than a square grid: event photos mix portrait and landscape, and
     cropping them all square throws away most of what the photographer framed. The host
     gallery butts its images together, so there is no gutter here either. */
  .grid {
    columns: 2;
    column-gap: 0;
  }

  @media (min-width: 700px) {
    .grid {
      columns: 3;
    }
  }

  @media (min-width: 1000px) {
    .grid {
      columns: 4;
    }
  }

  .cell,
  .ph {
    display: block;
    width: 100%;
    break-inside: avoid;
    margin: 0;
  }

  .ph {
    background: #f2f2f2;
  }

  .cell {
    padding: 0;
    border: 0;
    background: #f2f2f2;
    cursor: zoom-in;
    overflow: hidden;
    line-height: 0;
  }

  .cell img {
    display: block;
    width: 100%;
    height: auto;
    transition: opacity 0.2s ease;
  }

  .cell:hover img {
    opacity: 0.86;
  }

  .cell:focus-visible {
    outline: 2px solid #1863dc;
    outline-offset: -2px;
  }

  .empty {
    margin: 0;
    padding: 3rem 0;
    color: #8a8a8a;
  }

  .lightbox {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.92);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 3vmin;
    z-index: 2147483000; /* above anything the host page stacks around the embed */
  }

  .lightbox img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  .nav,
  .close {
    position: absolute;
    background: rgb(255 255 255 / 0.12);
    border: 1px solid rgb(255 255 255 / 0.25);
    color: #fff;
    border-radius: 999px;
    cursor: pointer;
    line-height: 1;
  }

  .nav {
    top: 50%;
    transform: translateY(-50%);
    width: 44px;
    height: 44px;
    font-size: 1.6rem;
  }

  .prev {
    left: 3vmin;
  }
  .next {
    right: 3vmin;
  }

  .close {
    top: 3vmin;
    right: 3vmin;
    width: 40px;
    height: 40px;
    font-size: 1.3rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .cell img {
      transition: none;
    }
  }
</style>
