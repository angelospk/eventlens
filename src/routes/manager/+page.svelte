<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import { config } from '$lib/config';
  import { today } from '$lib/date';
  import {
    fetchList,
    downloadPhoto,
    moderatePhoto,
    moderateAll,
    deletePhoto,
    saveEvent
  } from '$lib/manager-client';
  import { verifyPasscode } from '$lib/auth-client';
  import { loadManagerPasscode, saveManagerPasscode, clearPasscodes } from '$lib/session';
  import type { EventSettings, Moderation, PhotoListItem } from '$lib/types';

  let passcode = $state('');
  let loggedIn = $state(false);
  let checking = $state(false);
  let loginError = $state('');

  let date = $state(today());
  let photos = $state<PhotoListItem[]>([]);
  let event = $state<EventSettings>({ date: today(), title: null, autoApprove: false });
  let loading = $state(false);
  let error = $state('');
  let filter = $state<'all' | Moderation>('all');
  let lightbox = $state<PhotoListItem | null>(null);
  let busy = $state<Record<string, boolean>>({});

  const deps = $derived({ workerUrl: config.workerUrl, passcode });

  const counts = $derived({
    pending: photos.filter((p) => p.moderation === 'pending').length,
    approved: photos.filter((p) => p.moderation === 'approved').length,
    hidden: photos.filter((p) => p.moderation === 'hidden').length
  });

  const shown = $derived(filter === 'all' ? photos : photos.filter((p) => p.moderation === filter));

  const liveUrl = $derived(
    typeof location === 'undefined' ? '' : `${location.origin}${base}/live?date=${date}`
  );

  async function loadList() {
    loading = true;
    error = '';
    try {
      const res = await fetchList(deps, date);
      photos = res.photos;
      event = res.event;
    } catch (e) {
      error = String(e).includes('401')
        ? 'Λάθος κωδικός.'
        : 'Πρόβλημα δικτύου. Δοκίμασε ξανά.';
      photos = [];
    } finally {
      loading = false;
    }
  }

  async function login() {
    loginError = '';
    checking = true;
    try {
      const role = await verifyPasscode({ workerUrl: config.workerUrl }, passcode, 'manager');
      if (role !== 'manager') {
        loginError = 'Λάθος κωδικός.';
        return;
      }
      saveManagerPasscode(passcode);
      loggedIn = true;
      await loadList();
    } catch {
      loginError = 'Δεν υπάρχει σύνδεση με τον διακομιστή.';
    } finally {
      checking = false;
    }
  }

  function logout() {
    clearPasscodes();
    loggedIn = false;
    passcode = '';
    photos = [];
  }

  /** Optimistic: the chip flips at once and rolls back if the server disagrees. */
  async function setModeration(p: PhotoListItem, action: 'approve' | 'hide' | 'pending') {
    const before = p.moderation;
    const next: Moderation = action === 'approve' ? 'approved' : action === 'hide' ? 'hidden' : 'pending';
    busy = { ...busy, [p.id]: true };
    photos = photos.map((x) => (x.id === p.id ? { ...x, moderation: next } : x));
    try {
      await moderatePhoto(deps, p.id, action);
    } catch {
      photos = photos.map((x) => (x.id === p.id ? { ...x, moderation: before } : x));
      error = 'Η αλλαγή δεν αποθηκεύτηκε.';
    } finally {
      busy = { ...busy, [p.id]: false };
    }
  }

  async function approveEverything() {
    try {
      await moderateAll(deps, date, 'approve');
      await loadList();
    } catch {
      error = 'Η μαζική έγκριση απέτυχε.';
    }
  }

  async function remove(p: PhotoListItem) {
    if (!confirm(`Οριστική διαγραφή της φωτογραφίας "${p.original_name ?? p.id}";`)) return;
    busy = { ...busy, [p.id]: true };
    try {
      await deletePhoto(deps, p.id);
      photos = photos.filter((x) => x.id !== p.id);
      if (lightbox?.id === p.id) lightbox = null;
    } catch {
      error = 'Η διαγραφή απέτυχε. Η φωτογραφία παραμένει κρυφή.';
      await loadList();
    } finally {
      busy = { ...busy, [p.id]: false };
    }
  }

  async function toggleAutoApprove() {
    const next = !event.autoApprove;
    event = { ...event, autoApprove: next };
    try {
      await saveEvent(deps, { date, title: event.title, autoApprove: next });
    } catch {
      event = { ...event, autoApprove: !next };
      error = 'Ο διακόπτης δεν αποθηκεύτηκε.';
    }
  }

  async function saveTitle(value: string) {
    const before = event.title;
    event = { ...event, title: value };
    try {
      await saveEvent(deps, { date, title: value, autoApprove: event.autoApprove });
    } catch {
      event = { ...event, title: before }; // do not leave a title on screen that was never saved
      error = 'Ο τίτλος δεν αποθηκεύτηκε.';
    }
  }

  function copyLive() {
    navigator.clipboard?.writeText(liveUrl);
  }

  const chipFor = (m: Moderation) =>
    m === 'approved'
      ? { text: 'Δημόσια', cls: 'chip-ok' }
      : m === 'hidden'
        ? { text: 'Κρυφή', cls: 'chip-mute' }
        : { text: 'Για έγκριση', cls: 'chip-warn' };

  onMount(() => {
    const saved = loadManagerPasscode();
    if (saved) {
      passcode = saved;
      loggedIn = true;
      loadList();
    }
  });
</script>

<svelte:head>
  <title>EventLens - Διαχείριση</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="shell">
  {#if !loggedIn}
    <div class="login card">
      <h1>Διαχείριση</h1>
      <p class="sub">Έγκριση και έλεγχος των φωτογραφιών της βραδιάς.</p>
      <form onsubmit={(e) => { e.preventDefault(); login(); }}>
        <label for="mpc">Κωδικός διαχειριστή</label>
        <input id="mpc" type="password" bind:value={passcode} placeholder="Ο κωδικός σου"
               autocomplete="current-password" />
        {#if loginError}<p class="error" style="margin-top:.6rem">{loginError}</p>{/if}
        <button class="btn btn-primary" type="submit" disabled={checking || !passcode}
                style="width:100%;margin-top:1rem">
          {checking ? 'Έλεγχος' : 'Είσοδος'}
        </button>
      </form>
      <p class="hint" style="margin-top:1rem;font-size:.78rem">
        Ο κωδικός διαχειριστή ξεχνιέται όταν κλείσεις την καρτέλα.
      </p>
    </div>
  {:else}
    <header class="topbar">
      <div class="brand">
        <img src="{base}/icons/icon-192.png" alt="" />
        <h1>Διαχείριση</h1>
      </div>
      <input type="date" aria-label="Ημερομηνία βραδιάς" bind:value={date} onchange={loadList}
             style="width:auto" />
      <button class="btn btn-sm" onclick={logout}>Έξοδος</button>
    </header>

    <section class="card settings">
      <div class="setting">
        <label for="title">Τίτλος βραδιάς</label>
        <input id="title" type="text" value={event.title ?? ''} placeholder="π.χ. Γάμος Άννας και Νίκου"
               onchange={(e) => saveTitle((e.target as HTMLInputElement).value)} />
      </div>

      <div class="setting">
        <span class="setting-label">Δημοσίευση</span>
        <button class="switch" role="switch" aria-checked={event.autoApprove} onclick={toggleAutoApprove}>
          <span class="knob" class:on={event.autoApprove}></span>
          <span>{event.autoApprove ? 'Αυτόματη' : 'Με έγκριση'}</span>
        </button>
        <p class="hint">
          {event.autoApprove
            ? 'Κάθε φωτογραφία βγαίνει δημόσια μόλις ανέβει.'
            : 'Καμία φωτογραφία δεν είναι δημόσια πριν την εγκρίνεις.'}
        </p>
      </div>

      <div class="setting">
        <span class="setting-label">Σύνδεσμος για το κοινό</span>
        <div class="link-row">
          <code>{liveUrl}</code>
          <button class="btn btn-sm" onclick={copyLive}>Αντιγραφή</button>
        </div>
      </div>
    </section>

    {#if error}<p class="error" style="margin-bottom:1rem">{error}</p>{/if}

    <div class="filters">
      <button class="tab" class:active={filter === 'all'} onclick={() => (filter = 'all')}>
        Όλες <span class="num">{photos.length}</span>
      </button>
      <button class="tab" class:active={filter === 'pending'} onclick={() => (filter = 'pending')}>
        Για έγκριση <span class="num">{counts.pending}</span>
      </button>
      <button class="tab" class:active={filter === 'approved'} onclick={() => (filter = 'approved')}>
        Δημόσιες <span class="num">{counts.approved}</span>
      </button>
      <button class="tab" class:active={filter === 'hidden'} onclick={() => (filter = 'hidden')}>
        Κρυφές <span class="num">{counts.hidden}</span>
      </button>
      {#if counts.pending > 0}
        <button class="btn btn-sm btn-primary" style="margin-left:auto" onclick={approveEverything}>
          Έγκριση όλων
        </button>
      {/if}
    </div>

    {#if loading}
      <div class="grid">
        {#each Array(8) as _, i (i)}
          <div class="skeleton" style="aspect-ratio:1"></div>
        {/each}
      </div>
    {:else if shown.length === 0}
      <div class="empty">
        <p>{photos.length === 0 ? 'Καμία φωτογραφία για αυτή την ημερομηνία.' : 'Καμία φωτογραφία σε αυτή την κατηγορία.'}</p>
        <p class="hint">Οι φωτογραφίες εμφανίζονται εδώ μόλις τις ανεβάσει ο φωτογράφος.</p>
      </div>
    {:else}
      <div class="grid">
        {#each shown as p (p.id)}
          {@const c = chipFor(p.moderation)}
          <figure class="tile" class:dim={p.moderation !== 'approved'}>
            <button class="tile-img" onclick={() => (lightbox = p)} aria-label="Άνοιγμα φωτογραφίας">
              <img src={p.public_url} alt={p.original_name ?? ''} loading="lazy" />
            </button>
            <figcaption>
              <span class="chip {c.cls}">{c.text}</span>
              <div class="tile-actions">
                {#if p.moderation !== 'approved'}
                  <button class="btn btn-sm btn-primary" disabled={busy[p.id]}
                          onclick={() => setModeration(p, 'approve')}>Έγκριση</button>
                {:else}
                  <button class="btn btn-sm" disabled={busy[p.id]}
                          onclick={() => setModeration(p, 'hide')}>Απόκρυψη</button>
                {/if}
                <button class="btn btn-sm" onclick={() => downloadPhoto(p)}>Λήψη</button>
                <button class="btn btn-sm btn-danger" disabled={busy[p.id]}
                        onclick={() => remove(p)}>Διαγραφή</button>
              </div>
            </figcaption>
          </figure>
        {/each}
      </div>
    {/if}
  {/if}
</div>

{#if lightbox}
  <div
    class="lightbox"
    role="button"
    tabindex="0"
    aria-label="Κλείσιμο φωτογραφίας"
    onclick={() => (lightbox = null)}
    onkeydown={(e) => ['Escape', 'Enter', ' '].includes(e.key) && (lightbox = null)}
  >
    <img src={lightbox.public_url} alt={lightbox.original_name ?? ''} />
  </div>
{/if}

<style>
  .settings {
    display: grid;
    gap: 1.25rem;
    margin-bottom: 1.5rem;
  }

  @media (min-width: 760px) {
    .settings {
      grid-template-columns: 1fr 1fr 1fr;
      align-items: start;
    }
  }

  .setting-label {
    display: block;
    font-size: 0.82rem;
    color: var(--text-dim);
    margin-bottom: 0.4rem;
  }

  .switch {
    display: inline-flex;
    align-items: center;
    gap: 0.6rem;
    font: inherit;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--r-pill);
    padding: 0.35rem 0.9rem 0.35rem 0.4rem;
    cursor: pointer;
  }

  .knob {
    width: 34px;
    height: 20px;
    border-radius: var(--r-pill);
    background: var(--line);
    position: relative;
    transition: background 0.18s ease;
    flex: none;
  }

  .knob::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--text);
    transition: transform 0.18s ease;
  }

  .knob.on {
    background: var(--accent);
  }

  .knob.on::after {
    transform: translateX(14px);
    background: #fff;
  }

  .link-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .link-row code {
    flex: 1;
    min-width: 0;
    font-size: 0.75rem;
    color: var(--text-dim);
    background: var(--surface-2);
    border-radius: var(--r-input);
    padding: 0.5rem 0.6rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .filters {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }

  .tab {
    font: inherit;
    font-size: 0.85rem;
    color: var(--text-dim);
    background: none;
    border: 1px solid transparent;
    border-radius: var(--r-pill);
    padding: 0.4rem 0.85rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .tab.active {
    color: var(--text);
    background: var(--surface-2);
    border-color: var(--line);
  }

  .num {
    font-variant-numeric: tabular-nums;
    font-size: 0.75rem;
    color: var(--text-faint);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 0.85rem;
  }

  .tile {
    margin: 0;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    overflow: hidden;
    transition: opacity 0.18s ease;
  }

  .tile.dim img {
    opacity: 0.45;
  }

  .tile-img {
    display: block;
    width: 100%;
    padding: 0;
    border: none;
    background: var(--surface-2);
    cursor: zoom-in;
  }

  .tile-img img {
    display: block;
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
  }

  figcaption {
    display: flex;
    flex-direction: column;
    /* Without this the status chip stretches to the full tile width and reads as a bar. */
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.6rem;
  }

  .tile-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .lightbox {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.9);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2vmin;
    cursor: zoom-out;
    z-index: 50;
  }

  .lightbox img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: var(--r-card);
  }
</style>
