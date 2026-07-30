<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { v4 as uuid } from 'uuid';
  import { base } from '$app/paths';
  import { config } from '$lib/config';
  import { today, formatNight } from '$lib/date';
  import { createQueueStorage, type QueueStorage } from '$lib/idb-store';
  import { UploadQueue } from '$lib/upload-queue';
  import { makeR2Uploader, type Stage } from '$lib/r2-client';
  import { Session } from '$lib/session';
  import { fingerprintOf } from '$lib/fingerprint';
  import type { QueueItem } from '$lib/types';

  let passcode = $state('');
  let loggedIn = $state(false);
  let checking = $state(false);
  let loginError = $state('');
  let items = $state<QueueItem[]>([]);
  let completed = $state(0);
  let online = $state(true);
  let struggling = $state(false);
  let stage = $state<{ id: string; stage: Stage } | null>(null);
  let installEvent = $state<{ prompt: () => void } | null>(null);
  let iosInstallHint = $state(false);
  // True when the photographer was let in without the server confirming the passcode.
  // Signing in offline is deliberate, but it must not look like a verified session: a typo
  // would otherwise be discovered only when the first upload fails.
  let unverified = $state(false);
  // True when the queue lives only in memory because the database would not open.
  let ephemeral = $state(false);
  let queue: UploadQueue;
  let store: QueueStorage['store'];
  // A manager's token is accepted here too: same person, and being asked for a second
  // passcode just to upload is friction with nothing behind it.
  const session = new Session(config.workerUrl, 'photographer', undefined, ['manager']);

  // One object URL per queued file, revoked as soon as the item leaves the queue so a long
  // night of shooting does not leak hundreds of blobs.
  let thumbs = $state<Record<string, string>>({});
  let pickError = $state('');
  let skipped = $state('');

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
    // Sorted the way the queue processes them, so the order on screen is the order the
    // photographs will actually arrive rather than the database's own key order.
    const list = (await store.all())
      .filter((i) => i.status !== 'done')
      .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
    syncThumbs(list);
    items = list;
    completed = queue?.completed ?? 0;
    struggling = queue?.struggling ?? false;
    if (!items.some((i) => i.id === stage?.id)) stage = null;
    // The first request that gets through exchanges the passcode for a token, which
    // retroactively confirms an offline sign-in.
    if (unverified && session.verified) unverified = false;
  }

  async function start() {
    // Falls back to an in-memory queue rather than refusing to accept photographs when the
    // database will not open. Losing the queue on reload beats not being able to upload.
    const storage = await createQueueStorage();
    store = storage.store;
    ephemeral = storage.ephemeral;
    const uploader = makeR2Uploader({
      workerUrl: config.workerUrl,
      auth: () => session.headers(),
      onStage: (id, st) => (stage = { id, stage: st })
    });
    queue = new UploadQueue(store, uploader, config.retry, refresh);
    loggedIn = true;
    refresh();
    queue.drain(); // resume anything left from a previous session
  }

  async function login() {
    loginError = '';
    checking = true;
    try {
      const result = await session.signIn(passcode);
      if (result === 'bad') {
        loginError = 'Λάθος κωδικός, ή πολλές αποτυχημένες προσπάθειες. Δοκίμασε ξανά σε ένα λεπτό.';
        return;
      }
      // 'offline' still lets the photographer in: photos queue locally and the passcode is
      // exchanged for a token on the first request that gets through.
      unverified = result === 'offline';
      passcode = '';
      start();
    } finally {
      checking = false;
    }
  }

  function logout() {
    queue?.stop(); // otherwise it keeps retrying with credentials that no longer exist
    session.signOut();
    loggedIn = false;
    passcode = '';
    // Drop the rendered state with the session, otherwise the next login flashes the
    // previous photographer's queue and the object URLs behind it are never released.
    for (const url of Object.values(thumbs)) URL.revokeObjectURL(url);
    thumbs = {};
    items = [];
    completed = 0;
    pickError = '';
    skipped = '';
    void import('$lib/processor').then((m) => m.disposeProcessor());
  }

  async function onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files) return;
    pickError = '';
    eventDate = today(); // the night may have rolled over since the app was opened
    const pickedAt = Date.now();
    // Captured now: the FileList is cleared in the finally block, and reading its length
    // afterwards reports zero.
    const chosen = files.length;
    let failed = 0;
    let duplicates = 0;
    let reason = '';
    try {
      for (const [i, file] of Array.from(files).entries()) {
        try {
          const outcome = await queue.enqueue({
            id: uuid(),
            file,
            originalName: file.name,
            eventDate,
            status: 'pending',
            attempts: 0,
            fingerprint: fingerprintOf(file),
            // The index keeps a multi-file selection in the order the picker listed it,
            // since all of them are enqueued within the same millisecond.
            queuedAt: pickedAt + i
          });
          if (outcome === 'duplicate') duplicates++;
        } catch (e) {
          // Usually storage quota or a database that refuses to open. Either way the photo
          // is gone unless we say so: silence here looks exactly like success.
          failed++;
          reason = e instanceof Error ? e.message : '';
        }
      }
    } finally {
      input.value = ''; // let the same file be picked again after a discard
      if (failed > 0) {
        pickError =
          `${failed} από ${chosen} φωτογραφίες δεν μπήκαν σε σειρά. ` +
          (reason || 'Ο χώρος στη συσκευή μπορεί να έχει γεμίσει.');
      }
      // Skipping duplicates silently would look like photos going missing, so it is said
      // out loud and then fades on the next selection.
      skipped = duplicates
        ? duplicates === chosen
          ? duplicates === 1
            ? 'Αυτή η φωτογραφία έχει ήδη σταλεί.'
            : `Και οι ${duplicates} φωτογραφίες έχουν ήδη σταλεί.`
          : `${duplicates} από ${chosen} είχαν σταλεί ήδη και παραλείφθηκαν.`
        : '';
      await refresh();
      queue.drain();
    }
  }

  const STAGE_TEXT: Record<Stage, string> = {
    preparing: 'Ετοιμάζεται',
    processing: 'Επεξεργασία',
    sending: 'Στέλνεται',
    confirming: 'Ολοκληρώνεται'
  };

  function statusLabel(it: QueueItem) {
    if (it.status === 'error') return { text: 'Δεν στάλθηκε', cls: 'chip-danger' };
    if (it.status === 'uploading') {
      // Naming the step matters on a slow link: a photo can sit on "sending" for a minute
      // and the photographer needs to see movement, not wonder whether it is stuck.
      const st = stage?.id === it.id ? STAGE_TEXT[stage.stage] : 'Ανεβαίνει';
      return { text: st, cls: 'chip-accent' };
    }
    return { text: 'Σε σειρά', cls: 'chip-mute' };
  }

  // Three states, not two. `navigator.onLine` only knows whether the device thinks it has
  // a link; it says "online" on a festival hotspot that accepts the connection and then
  // drops every packet. `struggling` comes from uploads that actually failed.
  const connection = $derived(
    !online
      ? { text: 'Χωρίς δίκτυο', cls: 'chip-danger' }
      : struggling
        ? { text: 'Αδύναμο δίκτυο', cls: 'chip-warn' }
        : { text: 'Συνδεδεμένο', cls: 'chip-ok' }
  );

  async function install() {
    installEvent?.prompt();
    installEvent = null;
  }

  onMount(() => {
    online = navigator.onLine;
    const goOnline = () => {
      online = true;
      void queue?.resume(); // cut short any backoff that was waiting out the outage
    };
    const goOffline = () => (online = false);
    // Returning to a backgrounded app is the other moment worth retrying: mobile browsers
    // freeze timers while the tab is hidden.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void queue?.resume();
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    document.addEventListener('visibilitychange', onVisible);

    // Chrome and Edge hand us the install prompt; iOS never does, so it gets instructions.
    const onInstallPrompt = (e: Event) => {
      e.preventDefault();
      installEvent = e as unknown as { prompt: () => void };
    };
    window.addEventListener('beforeinstallprompt', onInstallPrompt);
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    iosInstallHint =
      !standalone && /iphone|ipad|ipod/i.test(navigator.userAgent) && !('onbeforeinstallprompt' in window);

    // A token from an earlier page load means no passcode prompt at all.
    if (session.restore()) start();

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('beforeinstallprompt', onInstallPrompt);
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
        <label for="pc">Κωδικός</label>
        <input id="pc" type="password" bind:value={passcode} placeholder="Ο κωδικός σου"
               autocomplete="current-password" />
        {#if loginError}<p class="error" style="margin-top:.6rem">{loginError}</p>{/if}
        <button class="btn btn-primary" type="submit" disabled={checking || !passcode}
                style="width:100%;margin-top:1rem">
          {checking ? 'Έλεγχος' : 'Είσοδος'}
        </button>
      </form>

      <p class="hint" style="margin-top:.75rem;font-size:.78rem">
        Δουλεύει και με τον κωδικό διαχειριστή.
      </p>

      {#if installEvent}
        <div class="install-inline">
          <span class="hint">Εγκατάστησέ την για να δουλεύει και χωρίς δίκτυο.</span>
          <button class="btn btn-sm" onclick={install}>Εγκατάσταση</button>
        </div>
      {:else if iosInstallHint}
        <p class="hint install-inline">
          Για να δουλεύει και χωρίς δίκτυο: «Μοιραστείτε» κάτω στη μπάρα του Safari,
          μετά «Στην οθόνη Αφετηρίας».
        </p>
      {/if}
    </div>
  {:else}
    <header class="topbar">
      <div class="brand">
        <img src="{base}/icons/icon-192.png" alt="" />
        <div>
          <h1>Ανέβασμα</h1>
          <!-- Named rather than numeric: after midnight the photographer needs to see at a
               glance that the shots are still filed under the night that is still going. -->
          <p class="hint" style="font-size:.78rem">Βραδιά {formatNight(eventDate)}</p>
        </div>
      </div>
      <span class="chip {connection.cls}">{connection.text}</span>
      <a class="btn btn-sm" href="{base}/manager">Διαχείριση</a>
      <button class="btn btn-sm" onclick={logout}>Έξοδος</button>
    </header>

    <div class="stats">
      <div><strong>{completed}</strong><span>ανέβηκαν</span></div>
      <div><strong>{pendingCount}</strong><span>σε ουρά</span></div>
      <div><strong>{failed.length}</strong><span>απέτυχαν</span></div>
    </div>

    {#if !online}
      <div class="banner banner-warn">
        <strong>Δεν υπάρχει δίκτυο</strong>
        <span>
          Συνέχισε κανονικά. Οι φωτογραφίες αποθηκεύονται στο κινητό και φεύγουν μόνες τους
          μόλις γυρίσει το σήμα. Μην κλείσεις την εφαρμογή.
        </span>
      </div>
    {:else if struggling}
      <div class="banner banner-warn">
        <strong>Το δίκτυο είναι αργό</strong>
        <span>Συνεχίζει να προσπαθεί. Δεν χάνεται καμία φωτογραφία.</span>
      </div>
    {/if}

    {#if installEvent}
      <div class="banner banner-install">
        <strong>Εγκατάστησέ την στο κινητό</strong>
        <span>Ανοίγει σαν κανονική εφαρμογή και δουλεύει και χωρίς δίκτυο.</span>
        <button class="btn btn-sm btn-primary" onclick={install}>Εγκατάσταση</button>
      </div>
    {:else if iosInstallHint}
      <div class="banner banner-install">
        <strong>Εγκατάστησέ την στο iPhone</strong>
        <span>
          Πάτα «Μοιραστείτε» κάτω στη μπάρα του Safari και μετά «Στην οθόνη Αφετηρίας».
          Έτσι ανοίγει σαν εφαρμογή και δουλεύει και χωρίς δίκτυο.
        </span>
      </div>
    {/if}

    <label class="picker" for="files">
      <span class="picker-title">Διάλεξε φωτογραφίες</span>
      <span class="hint">
        {online ? 'Ανεβαίνουν αυτόματα, μία μία.' : 'Θα μπουν σε σειρά για αργότερα.'}
      </span>
    </label>
    <input id="files" class="visually-hidden" type="file" accept="image/*,.heic,.heif,.HEIC,.HEIF" multiple onchange={onPick} />

    {#if ephemeral}
      <div class="notice">
        <strong>Μην κλείσεις την εφαρμογή</strong>
        <span class="hint">
          Η συσκευή δεν επιτρέπει τοπική αποθήκευση, οπότε η ουρά κρατιέται μόνο στη μνήμη.
          Οι φωτογραφίες ανεβαίνουν κανονικά, αλλά αν κλείσεις τη σελίδα πριν ανέβουν, χάνονται.
        </span>
      </div>
    {/if}

    {#if unverified && online}
      <div class="notice">
        <strong>Ο κωδικός δεν επιβεβαιώθηκε</strong>
        <span class="hint">
          Μπήκες χωρίς σύνδεση στον διακομιστή. Οι φωτογραφίες μπαίνουν κανονικά στην ουρά,
          αλλά αν ο κωδικός είναι λάθος θα αποτύχουν όταν γυρίσει το δίκτυο.
        </span>
      </div>
    {/if}

    {#if pickError}
      <p class="error" style="margin-bottom:1rem">{pickError}</p>
    {/if}

    {#if skipped}
      <p class="skipped">{skipped}</p>
    {/if}

    {#if failed.length > 0}
      <div class="retry-bar">
        <span class="error">
          {failed.length}
          {failed.length === 1 ? 'φωτογραφία δεν στάλθηκε' : 'φωτογραφίες δεν στάλθηκαν'}.
        </span>
        <button class="btn btn-sm" onclick={() => queue.retryAll()}>Δοκίμασε ξανά όλες</button>
      </div>
    {/if}

    {#if items.length === 0}
      <div class="empty">
        <p>Δεν υπάρχει τίποτα σε αναμονή.</p>
        <p class="hint">
          {completed > 0
            ? 'Όλες οι φωτογραφίες έχουν σταλεί.'
            : 'Ό,τι διαλέξεις εμφανίζεται εδώ μέχρι να σταλεί.'}
        </p>
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
              {:else if (it.tries ?? 0) > 1 && it.status !== 'uploading'}
                <span class="hint" style="font-size:.75rem">
                  Δοκιμή {it.tries} — περιμένει το δίκτυο
                </span>
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


  .banner {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.35rem;
    padding: 0.85rem 1rem;
    margin-bottom: 1.25rem;
    border-radius: var(--r-card);
    border: 1px solid transparent;
    font-size: 0.87rem;
    line-height: 1.45;
  }

  .banner strong {
    font-size: 0.95rem;
  }

  .banner-warn {
    background: var(--warn-soft);
    border-color: #fbbf2433;
    color: var(--text-dim);
  }

  .banner-warn strong {
    color: var(--warn);
  }

  .banner-install {
    background: var(--accent-soft);
    border-color: #6366f133;
    color: var(--text-dim);
  }

  .banner-install strong {
    color: var(--accent-text);
  }

  .banner button {
    margin-top: 0.3rem;
  }

  .notice {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    background: var(--warn-soft);
    border: 1px solid #fbbf2433;
    border-radius: var(--r-card);
  }

  .notice strong {
    color: var(--warn);
    font-size: 0.9rem;
  }

  .skipped {
    margin: 0 0 1rem;
    padding: 0.6rem 0.9rem;
    background: var(--surface-2);
    border-radius: var(--r-card);
    color: var(--text-dim);
    font-size: 0.87rem;
  }

  .install-inline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-top: 1.25rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--line);
    font-size: 0.82rem;
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
