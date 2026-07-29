<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { config } from '$lib/config';
  import { today, formatGreek, isValidDate } from '$lib/date';
  import { fetchWall } from '$lib/wall-client';
  import type { WallPhoto } from '$lib/types';

  // The public page for guests. Read-only, no passcode, and deliberately cheap: the Worker
  // response is edge-cached, so a full room refreshing costs very few database reads.
  const POLL_MS = 20000;

  let date = $state(today());
  let title = $state<string | null>(null);
  let photos = $state<WallPhoto[]>([]);
  let loaded = $state(false);
  let offline = $state(false);
  let lightboxIndex = $state<number | null>(null);

  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight: AbortController | null = null;

  // Newest first: on a live page the last photo taken is the one people want to see.
  const ordered = $derived([...photos].reverse());
  const heading = $derived(title ?? 'Φωτογραφίες της βραδιάς');

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
      title = res.title;
      offline = false;
    } catch {
      // Keep whatever is already on screen and try again on the next tick.
      if (!signal.aborted) offline = true;
    } finally {
      loaded = true;
    }
  }

  // Returns focus to the grid when the dialog closes, so keyboard users are not dumped at
  // the top of the document.
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

  onMount(() => {
    if (!browser) return;
    const qd = new URLSearchParams(location.search).get('date');
    if (qd && isValidDate(qd)) date = qd;
    refresh();
    timer = setInterval(refresh, POLL_MS);
    // Come back from a backgrounded tab with fresh photos rather than a stale grid.
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });

  onDestroy(() => {
    if (timer !== null) clearInterval(timer);
    inflight?.abort();
  });
</script>

<svelte:head>
  <title>{heading}</title>
  <meta name="description" content="Οι φωτογραφίες της βραδιάς, ζωντανά." />
</svelte:head>

<svelte:window onkeydown={onKey} />

<div class="shell">
  <header class="head">
    <h1>{heading}</h1>
    <p class="hint">{formatGreek(date)}</p>
    <div class="status">
      <span class="chip {offline ? 'chip-warn' : 'chip-ok'}">
        {offline ? 'Χωρίς σύνδεση' : 'Ζωντανά'}
      </span>
      {#if loaded}
        <span class="hint">{photos.length} φωτογραφίες</span>
      {/if}
    </div>
  </header>

  {#if !loaded}
    <div class="masonry">
      {#each Array(9) as _, i (i)}
        <div class="skeleton" style="height:{160 + (i % 3) * 60}px"></div>
      {/each}
    </div>
  {:else if ordered.length === 0}
    <div class="empty">
      <p>Δεν υπάρχουν ακόμα φωτογραφίες.</p>
      <p class="hint">Η σελίδα ανανεώνεται μόνη της, άφησέ την ανοιχτή.</p>
    </div>
  {:else}
    <div class="masonry">
      {#each ordered as p, i (p.id)}
        <button class="cell" onclick={(e) => openAt(i, e)} aria-label="Άνοιγμα φωτογραφίας">
          <img src={p.public_url} alt="" loading="lazy" decoding="async" />
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
    <!-- Focused on open so Escape and the arrow keys work without a click first, and so a
         screen reader lands inside the dialog rather than behind it. -->
    <button class="close" onclick={() => (lightboxIndex = null)} aria-label="Κλείσιμο"
            use:autofocus>×</button>
  </div>
{/if}

<style>
  .head {
    padding-block: 1.5rem 1.75rem;
  }

  .head h1 {
    font-size: clamp(1.5rem, 5vw, 2.25rem);
    font-weight: 600;
    margin-bottom: 0.35rem;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.9rem;
  }

  /* Columns rather than a square grid: event photos are a mix of portrait and landscape,
     and cropping them all to squares throws away most of what the photographer framed. */
  .masonry {
    columns: 2;
    column-gap: 0.6rem;
  }

  @media (min-width: 640px) {
    .masonry {
      columns: 3;
    }
  }

  @media (min-width: 1000px) {
    .masonry {
      columns: 4;
    }
  }

  .cell,
  .skeleton {
    display: block;
    width: 100%;
    break-inside: avoid;
    margin-bottom: 0.6rem;
  }

  .cell {
    padding: 0;
    border: none;
    background: var(--surface);
    border-radius: var(--r-card);
    overflow: hidden;
    cursor: zoom-in;
  }

  .cell img {
    display: block;
    width: 100%;
    height: auto;
    transition: transform 0.25s ease;
  }

  .cell:hover img {
    transform: scale(1.02);
  }

  .lightbox {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.94);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 3vmin;
    z-index: 50;
  }

  .lightbox img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  .nav,
  .close {
    position: absolute;
    background: rgb(255 255 255 / 0.1);
    border: 1px solid rgb(255 255 255 / 0.18);
    color: #fff;
    border-radius: var(--r-pill);
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
</style>
