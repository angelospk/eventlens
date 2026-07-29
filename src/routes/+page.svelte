<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { v4 as uuid } from 'uuid';
  import { base } from '$app/paths';
  import { config } from '$lib/config';
  import { today } from '$lib/date';
  import { IdbStore } from '$lib/idb-store';
  import { UploadQueue } from '$lib/upload-queue';
  import { makeR2Uploader } from '$lib/r2-client';
  import { verifyPasscode } from '$lib/auth-client';
  import { loadPhotographerPasscode, savePhotographerPasscode, clearPasscodes } from '$lib/session';
  import type { QueueItem } from '$lib/types';

  let passcode = $state('');
  let loggedIn = $state(false);
  let checking = $state(false);
  let loginError = $state('');
  let items = $state<QueueItem[]>([]);
  let completed = $state(0);
  let online = $state(true);
  let queue: UploadQueue;
  let store: IdbStore;

  // One object URL per queued file, revoked as soon as the item leaves the queue so a long
  // night of shooting does not leak hundreds of blobs.
  let thumbs = $state<Record<string, string>>({});
  let pickError = $state('');

  // Recomputed on every tick rather than frozen at mount: an app left open across midnight
  // would otherwise keep filing photos under yesterday's event.
  let eventDate = $state(today());

  const pendingCount = $derived(items.filter((i) => i.status !== 'error').length);
  const failed = $derived(items.filter((i) => i.status === 'error'));

  function syncThumbs(list: QueueItem[]) {
    const next: Record<string, string> = {};
    for (const it of list) {
      next[it.id] = thumbs[it.id] ?? URL.createObjectURL(it.file);
    }
    for (const [id, url] of Object.entries(thumbs)) {
      if (!next[id]) URL.revokeObjectURL(url);
    }
    thumbs = next;
  }

  async function refresh() {
    // 'done' rows only exist when storage refused a delete after a successful upload. They
    // are finished work, so they must not show up as something still waiting.
    const list = (await store.all()).filter((i) => i.status !== 'done');
    syncThumbs(list);
    items = list;
    completed = queue?.completed ?? 0;
  }

  function start(code: string) {
    store = new IdbStore();
    const uploader = makeR2Uploader({ workerUrl: config.workerUrl, passcode: code });
    queue = new UploadQueue(store, uploader, config.retry, refresh);
    loggedIn = true;
    refresh();
    queue.drain(); // resume anything left from a previous session
  }

  async function login() {
    loginError = '';
    checking = true;
    try {
      const role = await verifyPasscode({ workerUrl: config.workerUrl }, passcode, 'photographer');
      if (!role) {
        loginError = 'Λάθος κωδικός.';
        return;
      }
      savePhotographerPasscode(passcode);
      start(passcode);
    } catch {
      // No network: let the photographer in anyway. Photos queue locally and the passcode
      // gets checked for real on the first upload once there is signal again.
      savePhotographerPasscode(passcode);
      start(passcode);
    } finally {
      checking = false;
    }
  }

  function logout() {
    clearPasscodes();
    loggedIn = false;
    passcode = '';
    // Drop the rendered state with the session, otherwise the next login flashes the
    // previous photographer's queue and the object URLs behind it are never released.
    for (const url of Object.values(thumbs)) URL.revokeObjectURL(url);
    thumbs = {};
    items = [];
    completed = 0;
    pickError = '';
    void import('$lib/processor').then((m) => m.disposeProcessor());
  }

  async function onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files) return;
    pickError = '';
    eventDate = today(); // the night may have rolled over since the app was opened
    const pickedAt = Date.now();
    let failed = 0;
    try {
      for (const [i, file] of Array.from(files).entries()) {
        try {
          await queue.enqueue({
            id: uuid(),
            file,
            originalName: file.name,
            eventDate,
            status: 'pending',
            attempts: 0,
            // The index keeps a multi-file selection in the order the picker listed it,
            // since all of them are enqueued within the same millisecond.
            queuedAt: pickedAt + i
          });
        } catch {
          // Almost always storage quota. Say so instead of dropping the photo in silence.
          failed++;
        }
      }
    } finally {
      input.value = ''; // let the same file be picked again after a discard
      if (failed > 0) {
        pickError = `${failed} από ${files.length} φωτογραφίες δεν μπήκαν στην ουρά. Ο χώρος στη συσκευή μπορεί να έχει γεμίσει.`;
      }
      await refresh();
      queue.drain();
    }
  }

  function statusLabel(it: QueueItem) {
    if (it.status === 'uploading') return { text: 'Ανεβαίνει', cls: 'chip-accent' };
    if (it.status === 'error') return { text: 'Απέτυχε', cls: 'chip-danger' };
    return { text: 'Σε αναμονή', cls: 'chip-mute' };
  }

  onMount(() => {
    online = navigator.onLine;
    const goOnline = () => {
      online = true;
      queue?.drain();
    };
    const goOffline = () => (online = false);
    // Returning to a backgrounded app is the other moment worth retrying: mobile browsers
    // freeze timers while the tab is hidden.
    const onVisible = () => {
      if (document.visibilityState === 'visible') queue?.drain();
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    document.addEventListener('visibilitychange', onVisible);

    const saved = loadPhotographerPasscode();
    if (saved) {
      passcode = saved;
      start(saved);
    }

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  });

  onDestroy(() => {
    for (const url of Object.values(thumbs)) URL.revokeObjectURL(url);
  });
</script>

<svelte:head>
  <title>EventLens</title>
</svelte:head>

<div class="shell">
  {#if !loggedIn}
    <div class="login card">
      <h1>EventLens</h1>
      <p class="sub">Ανέβασμα φωτογραφιών για τη βραδιά.</p>
      <form onsubmit={(e) => { e.preventDefault(); login(); }}>
        <label for="pc">Κωδικός φωτογράφου</label>
        <input id="pc" type="password" bind:value={passcode} placeholder="Ο κωδικός σου"
               autocomplete="current-password" />
        {#if loginError}<p class="error" style="margin-top:.6rem">{loginError}</p>{/if}
        <button class="btn btn-primary" type="submit" disabled={checking || !passcode}
                style="width:100%;margin-top:1rem">
          {checking ? 'Έλεγχος' : 'Είσοδος'}
        </button>
      </form>
    </div>
  {:else}
    <header class="topbar">
      <div class="brand">
        <img src="{base}/icons/icon-192.png" alt="" />
        <div>
          <h1>Ανέβασμα</h1>
          <p class="hint" style="font-size:.78rem">{eventDate}</p>
        </div>
      </div>
      <span class="chip {online ? 'chip-ok' : 'chip-warn'}">
        {online ? 'Συνδεδεμένο' : 'Εκτός δικτύου'}
      </span>
      <button class="btn btn-sm" onclick={logout}>Έξοδος</button>
    </header>

    <div class="stats">
      <div><strong>{completed}</strong><span>ανέβηκαν</span></div>
      <div><strong>{pendingCount}</strong><span>σε ουρά</span></div>
      <div><strong>{failed.length}</strong><span>απέτυχαν</span></div>
    </div>

    <label class="picker" for="files">
      <span class="picker-title">Διάλεξε φωτογραφίες</span>
      <span class="hint">
        {online
          ? 'Ανεβαίνουν αυτόματα, μία μία.'
          : 'Χωρίς δίκτυο: μπαίνουν στην ουρά και θα σταλούν μόλις γυρίσει το σήμα.'}
      </span>
    </label>
    <input id="files" class="visually-hidden" type="file" accept="image/*" multiple onchange={onPick} />

    {#if pickError}
      <p class="error" style="margin-bottom:1rem">{pickError}</p>
    {/if}

    {#if failed.length > 0}
      <div class="retry-bar">
        <span class="error">{failed.length} φωτογραφίες δεν στάλθηκαν.</span>
        <button class="btn btn-sm" onclick={() => queue.retryAll()}>Δοκίμασε ξανά όλες</button>
      </div>
    {/if}

    {#if items.length === 0}
      <div class="empty">
        <p>Η ουρά είναι άδεια.</p>
        <p class="hint">Ό,τι διαλέξεις εμφανίζεται εδώ μέχρι να ανέβει.</p>
      </div>
    {:else}
      <ul class="queue">
        {#each items as it (it.id)}
          {@const s = statusLabel(it)}
          <li class="row">
            <img class="thumb" src={thumbs[it.id]} alt="" />
            <div class="meta">
              <span class="name">{it.originalName}</span>
              <span class="chip {s.cls}">{s.text}</span>
              {#if it.status === 'error' && it.lastError}
                <span class="error">{it.lastError}</span>
              {/if}
            </div>
            {#if it.status === 'error'}
              <div class="row-actions">
                <button class="btn btn-sm" onclick={() => queue.retryItem(it.id)}>Ξανά</button>
                <button class="btn btn-sm btn-danger" onclick={() => queue.discard(it.id)}>Διαγραφή</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    overflow: hidden;
    margin-bottom: 1.25rem;
  }

  .stats div {
    background: var(--surface);
    padding: 0.9rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .stats strong {
    font-size: 1.5rem;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .stats span {
    font-size: 0.78rem;
    color: var(--text-dim);
  }

  .picker {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    text-align: center;
    min-height: 128px;
    padding: 1.5rem;
    margin-bottom: 1.25rem;
    border: 1px dashed var(--line);
    border-radius: var(--r-card);
    background: var(--surface);
    cursor: pointer;
    transition:
      border-color 0.18s ease,
      background 0.18s ease;
  }

  .picker:hover {
    border-color: var(--accent);
    background: var(--surface-2);
  }

  .picker-title {
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--text);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .retry-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    background: var(--danger-soft);
    border: 1px solid #f8717133;
    border-radius: var(--r-card);
  }

  .queue {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    padding: 0.6rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
  }

  .thumb {
    width: 56px;
    height: 56px;
    object-fit: cover;
    border-radius: var(--r-input);
    flex: none;
    background: var(--surface-2);
  }

  .meta {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.3rem;
    min-width: 0;
    flex: 1;
  }

  .name {
    font-size: 0.9rem;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-actions {
    display: flex;
    gap: 0.4rem;
    flex: none;
  }

  @media (max-width: 480px) {
    .row {
      flex-wrap: wrap;
    }
    .row-actions {
      width: 100%;
      justify-content: flex-end;
    }
  }
</style>
