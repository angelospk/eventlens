<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { config } from '$lib/config';
  import { today, formatGreek, formatNight, isValidDate } from '$lib/date';
  import { fetchWall, fetchDays, type EventDay } from '$lib/wall-client';
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
  /**
   * Every night the festival has photographs for.
   *
   * This is what makes one embedded iframe enough for the whole festival: a new evening
   * appears as another tab here rather than as another block someone has to add to the
   * host page. Kept even when there is only one night, so nobody wonders where the rest
   * went on the second day.
   */
  let days = $state<EventDay[]>([]);
  /** True when the visitor asked for a night by hand, which then outranks anything new. */
  let pinned = false;

  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight: AbortController | null = null;
  let daysInflight: AbortController | null = null;
  /**
   * Which night the newest request was for. A viewer tapping through four tabs leaves four
   * requests in the air, and without this the slowest one wins and puts the wrong evening's
   * photographs under the wrong heading.
   */
  let wanted = '';

  // Newest first: on a live page the last photo taken is the one people want to see.
  const ordered = $derived([...photos].reverse());
  const heading = $derived(formatGreek(date));

  async function refresh() {
    inflight?.abort();
    inflight = new AbortController();
    const signal = inflight.signal;
    const asked = date;
    wanted = asked;
    try {
      const res = await fetchWall(
        { workerUrl: config.workerUrl, fetchImpl: (u, o) => fetch(u, { ...o, signal }) },
        asked
      );
      if (wanted !== asked) return; // the viewer moved on while this was in the air
      photos = res.photos;
    } catch {
      // Keep whatever is already on screen and try again on the next tick.
    } finally {
      if (wanted === asked) loaded = true;
    }
  }

  /**
   * Refreshes the list of nights, and picks one the first time round.
   *
   * A visitor who has not asked for a night gets the newest one that actually has
   * photographs — decided by the Worker, not by this browser's clock, because a viewer in
   * another country would otherwise resolve a different evening. Someone already looking at
   * a night is never moved off it when a newer one appears; the tab simply shows up.
   */
  async function refreshDays(first = false) {
    daysInflight?.abort();
    daysInflight = new AbortController();
    const signal = daysInflight.signal;
    try {
      const res = await fetchDays({
        workerUrl: config.workerUrl,
        fetchImpl: (u, o) => fetch(u, { ...o, signal })
      });
      days = res.days;
      if (first && !pinned && res.defaultDate) {
        date = res.defaultDate;
        return true;
      }
    } catch {
      // No strip, one night. Strictly better than an empty page.
    }
    return false;
  }

  function pick(d: string) {
    if (d === date) return;
    pinned = true;
    date = d;
    lightboxIndex = null;
    photos = [];
    loaded = false;
    // Keeps the address bar honest so the night on screen can be linked to or reloaded.
    // replaceState rather than pushState: tabbing through nights should not fill the back
    // button with steps out of an iframe.
    const url = new URL(location.href);
    url.searchParams.set('date', d);
    history.replaceState(null, '', url);
    refresh();
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

  /**
   * The two photographs either side of the one being looked at.
   *
   * The grid shows thumbnails; the lightbox shows the full photograph, so every arrow press
   * starts a download from cold and the screen sits on the old picture while it arrives.
   * Fetching the neighbours while the current one is being looked at spends that wait on
   * time the viewer is already spending. Only two, and only with the lightbox open: a
   * whole night of full-size photographs is not something to pull down over event Wi-Fi.
   */
  const neighbours = $derived.by(() => {
    if (lightboxIndex === null || ordered.length < 2) return [];
    const n = ordered.length;
    const urls = [ordered[(lightboxIndex + 1) % n], ordered[(lightboxIndex - 1 + n) % n]]
      .map((p) => p?.public_url)
      .filter((u): u is string => Boolean(u) && u !== ordered[lightboxIndex!]?.public_url);
    return [...new Set(urls)];
  });

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
  /** Measured instead of the document: see below. */
  let contentEl: HTMLElement | null = $state(null);
  let sentHeight = 0;
  let raf = 0;

  function reportHeight() {
    if (window.parent === window || !contentEl) return;
    // The content's own height, not the document's. Once the browser has stretched
    // <html> to fill a tall iframe it does not shrink back, so measuring the document
    // means the gallery can grow when a night is added and never shrink when the viewer
    // switches to a shorter one — leaving a screen of blank space on the host page.
    const h = Math.ceil(contentEl.getBoundingClientRect().height);
    if (h === sentHeight || h <= 0) return;
    sentHeight = h;
    // Named, not '*': the height is harmless, but a wildcard hands any page that frames
    // this a message channel it did not have to ask for.
    for (const origin of config.embedOrigins) {
      window.parent.postMessage({ type: 'eventlens:height', height: h }, origin);
    }
  }

  /** Coalesces the burst of observer callbacks a layout change produces into one message. */
  function scheduleHeight() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      reportHeight();
    });
  }

  onMount(() => {
    if (!browser) return;
    const qd = new URLSearchParams(location.search).get('date');
    // An explicit date always wins, even for a night with nothing in it: a link someone was
    // sent must show what it says, not quietly redirect to a different evening.
    if (qd && isValidDate(qd)) {
      date = qd;
      pinned = true;
    }
    // The night is settled before the photographs are asked for, so an unpinned visitor
    // does not watch an empty "today" load and then get replaced.
    void refreshDays(true).then(refresh);
    timer = setInterval(() => {
      refresh();
      refreshDays();
    }, POLL_MS);
    // Come back from a backgrounded tab with fresh photos rather than a stale grid.
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);

    observer = new ResizeObserver(scheduleHeight);
    if (contentEl) observer.observe(contentEl);
    // Images settle after the observer fires, so report again once they have loaded.
    window.addEventListener('load', scheduleHeight);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('load', scheduleHeight);
    };
  });

  onDestroy(() => {
    if (timer !== null) clearInterval(timer);
    if (raf) cancelAnimationFrame(raf);
    observer?.disconnect();
    inflight?.abort();
    daysInflight?.abort();
  });
</script>

<svelte:head>
  <title>{heading}</title>
  <meta name="description" content="Οι φωτογραφίες της βραδιάς." />
  {#each neighbours as url (url)}
    <link rel="preload" as="image" href={url} />
  {/each}
</svelte:head>

<svelte:window onkeydown={onKey} />

<div class="page" bind:this={contentEl}>
  <h1>{heading}</h1>

  <!-- One tab per evening, newest first. Hidden while there is only one night: a single tab
       is a control that cannot do anything. -->
  {#if days.length > 1}
    <nav class="days" aria-label="Βραδιές">
      {#each days as d (d.date)}
        <button class="day" class:on={d.date === date} onclick={() => pick(d.date)}
                aria-current={d.date === date ? 'true' : undefined}>
          {d.title || formatNight(d.date)}
          <span class="count">{d.count}</span>
        </button>
      {/each}
    </nav>
  {/if}

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
          <img src={p.thumb_url ?? p.public_url} alt="" loading="lazy" decoding="async"
               onload={reportHeight} />
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

  /* Scrolls sideways rather than wrapping: a festival that runs a week would otherwise
     push the photographs down the page behind four rows of tabs. */
  .days {
    display: flex;
    gap: 0.5rem;
    margin: 0 0 clamp(1rem, 3vw, 1.75rem);
    padding-bottom: 0.35rem;
    overflow-x: auto;
    scrollbar-width: thin;
  }

  .day {
    flex: none;
    display: inline-flex;
    align-items: baseline;
    gap: 0.4rem;
    padding: 0.45rem 0.9rem;
    font: inherit;
    font-size: 0.9rem;
    color: #6b6b6b;
    background: #f4f4f4;
    border: 1px solid transparent;
    border-radius: 999px;
    cursor: pointer;
    white-space: nowrap;
  }

  .day:hover { color: #000; }

  .day.on {
    color: #fff;
    background: #000;
  }

  .day .count {
    font-size: 0.75rem;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
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
