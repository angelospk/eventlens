<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { v4 as uuid } from 'uuid';
  import { base } from '$app/paths';
  import { config } from '$lib/config';
  import { today, formatNight } from '$lib/date';
  import { uploads } from '$lib/uploads.svelte';
  import type { Stage } from '$lib/r2-client';
  import { fingerprintOf } from '$lib/fingerprint';
  import { diagnose, type Diagnosis } from '$lib/diagnostics';
  import { loadPreference, savePreference, type FormatPreference } from '$lib/image-format';
  import { dump, entries, clearLog, onLog, log } from '$lib/log';
  import type { QueueItem } from '$lib/types';

  let passcode = $state('');
  let loggedIn = $state(false);
  let checking = $state(false);
  let loginError = $state('');
  let online = $state(true);
  const items = $derived(uploads.items);
  const completed = $derived(uploads.completed);
  const struggling = $derived(uploads.struggling);
  const stage = $derived(uploads.stage);
  const ephemeral = $derived(uploads.ephemeral);
  const activeId = $derived(uploads.activeId);
  let installEvent = $state<{ prompt: () => void } | null>(null);
  let iosInstallHint = $state(false);
  // True when the photographer was let in without the server confirming the passcode.
  // Signing in offline is deliberate, but it must not look like a verified session: a typo
  // would otherwise be discovered only when the first upload fails.
  let unverified = $state(false);
  // Ticks only while something is uploading, so a wedged attempt turns into an offer of
  // help on its own rather than sitting there looking busy.
  let nowTick = $state(Date.now());
  // How long an attempt may run before the interface stops calling it progress. Requests
  // already abort themselves well before this; a photograph still here after it is one the
  // photographer should be able to take into their own hands.
  const STUCK_AFTER_MS = 25_000;
  // Which photograph this instance is genuinely working on. A row can say 'uploading' in
  // the database while nobody is uploading it — another tab held the queue, or the app was
  // killed mid-attempt — and calling that "uploading" is how six photographs end up looking
  // busy at once when only one ever is.
  const isUploading = (it: QueueItem) => it.status === 'uploading' && it.id === activeId;
  const isStuck = (it: QueueItem) =>
    isUploading(it) && !!it.startedAt && nowTick - it.startedAt > STUCK_AFTER_MS;
  const stuckItems = $derived(items.filter(isStuck));
  let doctorOpen = $state(false);
  // The record of what actually happened, kept so a failure in a field can be looked at
  // afterwards instead of described from memory.
  let logLines = $state<string[]>([]);
  let logNote = $state('');
  let doctorRunning = $state(false);
  let doctor = $state<Diagnosis | null>(null);
  let formatPref = $state<FormatPreference>('auto');
  // The queue belongs to the app, not to this screen: it keeps running while the manager
  // page is open, and coming back here must not build a second one.
  const queue = $derived(uploads.queue!);
  const store = $derived(uploads.store!);
  const session = uploads.session;

  // One object URL per queued file, revoked as soon as the item leaves the queue so a long
  // night of shooting does not leak hundreds of blobs.
  let thumbs = $state<Record<string, string>>({});
  let pickError = $state('');
  // The most recent photograph to land, kept so the first question on reopening the app
  // ("where did I get to") has an answer that a running total cannot give.
  let lastDone = $state<{ name: string; at: number; url: string } | null>(null);
  // Rows whose bytes the device can no longer produce. Queued by an older version that
  // kept a handle to the file rather than a copy of it, and orphaned by a reload.
  let unreadable = $state<Record<string, boolean>>({});
  let skipped = $state('');

  // Recomputed on every tick rather than frozen at mount: an app left open across midnight
  // would otherwise keep filing photos under yesterday's event.
  let eventDate = $state(today());

  const pendingCount = $derived(items.filter((i) => i.status !== 'error').length);
  const failed = $derived(items.filter((i) => i.status === 'error'));

  // Previews are made for the top of the queue only. Each one holds a whole multi-megapixel
  // photograph open in memory to draw a 56-pixel square, and a burst of fifty is enough for
  // iOS to kill the tab — which then reopens on the same fifty and does it again.
  const PREVIEW_LIMIT = 12;

  function syncThumbs(list: QueueItem[]) {
    const next: Record<string, string> = {};
    for (const it of list.slice(0, PREVIEW_LIMIT)) {
      next[it.id] = thumbs[it.id] ?? URL.createObjectURL(it.file);
    }
    for (const [id, url] of Object.entries(thumbs)) {
      if (!next[id]) URL.revokeObjectURL(url);
    }
    thumbs = next;
  }

  // Previews are this screen's business, not the queue's, so they are kept here and
  // rebuilt whenever the shared list changes.
  $effect(() => {
    const list = uploads.items;
    const done = uploads.lastDone;
    // The bodies below both read and write the previews they maintain, which inside a
    // tracked block would make the effect re-run itself forever. Only the queue's own
    // state above decides when this runs.
    untrack(() => {
      syncThumbs(list);
      if (done && done.at !== lastDone?.at) {
        // Exactly one preview is held at a time; the previous one is released here rather
        // than accumulating a night's worth of object URLs.
        if (lastDone) URL.revokeObjectURL(lastDone.url);
        lastDone = { name: done.name, at: done.at, url: URL.createObjectURL(done.file) };
      }
      // The first request that gets through exchanges the passcode for a token, which
      // retroactively confirms an offline sign-in.
      if (unverified && session.verified) unverified = false;
    });
  });

  const refresh = () => uploads.refresh();

  const readLog = () =>
    (logLines = entries()
      .slice(-120)
      .reverse()
      .map((e) => {
        const d = new Date(e.t);
        const p = (n: number) => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${e.msg}`;
      }));

  async function shareLog() {
    const text = dump();
    logNote = '';
    // Sharing beats copying on a phone: it opens Messages or Mail with the text already in
    // it, which is the whole journey rather than the first step of it.
    try {
      const share = (navigator as unknown as { share?: (d: { title: string; text: string }) => Promise<void> }).share;
      if (share) {
        await share.call(navigator, { title: 'EventLens log', text });
        return;
      }
    } catch {
      // Cancelled, or refused. Fall through to the clipboard.
    }
    try {
      await navigator.clipboard.writeText(text);
      logNote = 'Αντιγράφηκε.';
    } catch {
      logNote = 'Δεν έγινε αντιγραφή. Κράτα screenshot.';
    }
  }

  function downloadLog() {
    const url = URL.createObjectURL(new Blob([dump()], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `eventlens-log-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function runDoctor() {
    doctorRunning = true;
    doctorOpen = true;
    readLog();
    onLog(readLog);
    try {
      doctor = await diagnose({
        workerUrl: config.workerUrl,
        auth: () => session.headers(),
        eventDate
      });
    } finally {
      doctorRunning = false;
    }
  }

  function setFormat(pref: FormatPreference) {
    formatPref = pref;
    savePreference(pref);
    // The queue re-asks for the format on the next photograph, so anything already failing
    // is worth retrying under the new choice.
    queue?.retryAll();
  }

  async function start() {
    formatPref = loadPreference();
    try {
      // Awaited before the screen appears: the queue is opening IndexedDB, and a
      // photographer quick enough to pick files during that window would otherwise reach a
      // queue that does not exist yet.
      await uploads.start();
    } catch (e) {
      // Said out loud rather than swallowed. A silent failure here looks exactly like the
      // password being wrong, and the photographer retypes it all night.
      const why = e instanceof Error ? e.message : String(e);
      log('app', `could not open the queue: ${why}`);
      loginError = `Δεν άνοιξε η ουρά ανεβάσματος. ${why}`;
      return;
    }
    loggedIn = true;
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
      await start();
      // Anything that failed on the old, expired credentials deserves another go now that
      // there are new ones — otherwise signing back in leaves a screen full of failures
      // that the photographer has to notice and clear by hand.
      if (loggedIn) void uploads.queue?.retryAll();
    } finally {
      checking = false;
    }
  }

  function logout() {
    // Stops the queue and drops the credentials: otherwise it keeps retrying with a token
    // the user has just signed out of.
    uploads.reset();
    loggedIn = false;
    passcode = '';
    // Drop the rendered state with the session, otherwise the next login flashes the
    // previous photographer's queue and the object URLs behind it are never released.
    for (const url of Object.values(thumbs)) URL.revokeObjectURL(url);
    thumbs = {};
    if (lastDone) URL.revokeObjectURL(lastDone.url);
    lastDone = null;
    pickError = '';
    skipped = '';
    void import('$lib/processor').then((m) => m.disposeProcessor());
  }

  async function onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files || !uploads.ready) return;
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
          // Copied into memory rather than queued as picked.
          //
          // A File from the picker is a handle to something on disk, and iOS revokes that
          // handle when the app is reloaded or killed. The row survives in the database and
          // the bytes do not: the thumbnail turns into a broken image and the upload can
          // never read it. Taking a real copy costs the memory of one photograph for the
          // moment it takes to store it, and makes the queue mean what it says.
          const bytes = new Blob([await file.arrayBuffer()], {
            type: file.type || 'image/jpeg'
          });
          const outcome = await queue.enqueue({
            id: uuid(),
            file: bytes,
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

  function retryStuck() {
    // retryMany abandons the request in the air and keeps the photograph. Cancelling first
    // would delete it, which is the opposite of what the button says.
    return queue.retryMany(stuckItems.map((i) => i.id));
  }

  async function cancelStuck() {
    // Asked for out loud. "Άκυρο" reads as "stop waiting", but the row and the only copy of
    // the photograph go with it, and a merely slow upload passes the 25-second mark all the
    // time on a bad link.
    const n = stuckItems.length;
    const sure = confirm(
      n === 1
        ? 'Η φωτογραφία θα διαγραφεί από την ουρά και δεν θα σταλεί. Σίγουρα;'
        : `${n} φωτογραφίες θα διαγραφούν από την ουρά και δεν θα σταλούν. Σίγουρα;`
    );
    if (!sure) return;
    for (const id of stuckItems.map((i) => i.id)) await queue.cancel(id);
  }

  function statusLabel(it: QueueItem) {
    if (it.status === 'error') return { text: 'Δεν στάλθηκε', cls: 'chip-danger' };
    if (isStuck(it)) return { text: 'Αργεί πολύ', cls: 'chip-warn' };
    if (isUploading(it)) {
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
    // Only runs while something is in flight: no timer burning battery on an idle screen.
    const tick = setInterval(() => {
      if (items.some((i) => i.status === 'uploading')) nowTick = Date.now();
    }, 2000);

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
      clearInterval(tick);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('beforeinstallprompt', onInstallPrompt);
    };
  });

  onDestroy(() => {
    for (const url of Object.values(thumbs)) URL.revokeObjectURL(url);
    onLog(null);
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
      <button class="btn btn-sm" onclick={runDoctor}>Έλεγχος</button>
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


    {#if doctorOpen}
      <section class="doctor card">
        <header class="doctor-head">
          <strong>Έλεγχος συστήματος</strong>
          <button class="btn btn-sm" onclick={() => (doctorOpen = false)}>Κλείσιμο</button>
        </header>

        {#if doctorRunning}
          <p class="hint">Γίνεται έλεγχος, ανεβαίνει και μια δοκιμαστική εικόνα…</p>
        {:else if doctor}
          <ul class="doctor-list">
            {#each doctor.checks as c (c.name)}
              <li>
                <span class="chip {c.state === 'ok' ? 'chip-ok' : c.state === 'warn' ? 'chip-warn' : 'chip-danger'}">
                  {c.state === 'ok' ? 'Εντάξει' : c.state === 'warn' ? 'Προσοχή' : 'Πρόβλημα'}
                </span>
                <div>
                  <strong>{c.name}</strong>
                  <span class="hint">{c.detail}</span>
                </div>
              </li>
            {/each}
          </ul>

          {#if doctor.suggestion}
            <p class="hint" style="margin-top:.75rem">
              Δοκίμασε να αλλάξεις τη μορφή σε
              <strong>{doctor.suggestion === 'jpeg' ? 'JPEG' : 'WebP'}</strong> παρακάτω.
            </p>
          {/if}

          <button class="btn btn-sm" style="margin-top:.75rem" onclick={runDoctor}>Ξανά</button>
        {/if}

        <div class="doctor-log">
          <span class="setting-label">Καταγραφή ({entries().length} γραμμές)</span>
          <p class="hint">
            Ό,τι έκανε το ανέβασμα, με ώρες. Κρατιέται ακόμα κι αν κλείσει η εφαρμογή.
          </p>
          <div class="log-actions">
            <button class="btn btn-sm" onclick={shareLog}>Στείλε την καταγραφή</button>
            <button class="btn btn-sm" onclick={downloadLog}>Αποθήκευση</button>
            <button class="btn btn-sm btn-danger" onclick={() => { clearLog(); readLog(); }}>Καθάρισμα</button>
          </div>
          {#if logNote}<p class="hint">{logNote}</p>{/if}
          <pre class="log-view">{logLines.join('\n') || 'Τίποτα ακόμα.'}</pre>
        </div>

        <div class="doctor-format">
          <span class="setting-label">Μορφή αρχείων</span>
          <div class="seg">
            {#each [['auto', 'Αυτόματη'], ['webp', 'WebP'], ['jpeg', 'JPEG']] as [value, label] (value)}
              <button class="seg-btn" class:on={formatPref === value}
                      onclick={() => setFormat(value as FormatPreference)}>{label}</button>
            {/each}
          </div>
          <p class="hint">
            Η αυτόματη διαλέγει το μικρότερο που αντέχει η συσκευή. Το JPEG είναι μεγαλύτερο
            αλλά δουλεύει παντού. Άλλαξέ το μόνο αν ο έλεγχος δείχνει πρόβλημα στην επεξεργασία.
          </p>
        </div>
      </section>
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

    {#if lastDone}
      <div class="last-done">
        <img src={lastDone.url} alt="" />
        <div>
          <span class="last-name">{lastDone.name}</span>
          <span class="hint">
            Τελευταία που ανέβηκε, {new Date(lastDone.at).toLocaleTimeString('el-GR', {
              hour: '2-digit',
              minute: '2-digit'
            })}
          </span>
        </div>
      </div>
    {/if}

    {#if stuckItems.length > 0}
      <div class="retry-bar">
        <span class="hint">{stuckItems.length} αργούν πολύ.</span>
        <span style="display:flex;gap:.4rem">
          <button class="btn btn-sm" onclick={retryStuck}>Ξανά όλες</button>
          <button class="btn btn-sm btn-danger" onclick={cancelStuck}>Άκυρο όλες</button>
        </span>
      </div>
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
            {#if unreadable[it.id]}
              <div class="thumb thumb-gone" aria-hidden="true">!</div>
            {:else if thumbs[it.id]}
              <img class="thumb" src={thumbs[it.id]} alt="" loading="lazy"
                   onerror={() => (unreadable = { ...unreadable, [it.id]: true })} />
            {:else}
              <div class="thumb thumb-placeholder" aria-hidden="true"></div>
            {/if}
            <div class="meta">
              <span class="name">{it.originalName}</span>
              <span class="chip {s.cls}">{s.text}</span>
              {#if unreadable[it.id]}
                <span class="error">
                  Το αρχείο δεν είναι πια διαθέσιμο στη συσκευή. Διάλεξέ το ξανά.
                </span>
              {:else if it.status === 'error' && it.lastError}
                <span class="error">{it.lastError}</span>
              {:else if (it.tries ?? 0) > 1 && it.status !== 'uploading'}
                <!-- A raw attempt count reads as an alarm. What the photographer needs to
                     know is that it is still trying and nothing is lost. -->
                <span class="hint" style="font-size:.75rem">Περιμένει δίκτυο, ξαναδοκιμάζει μόνο του</span>
              {/if}
            </div>
            {#if unreadable[it.id]}
              <div class="row-actions">
                <button class="btn btn-sm btn-danger" onclick={() => queue.cancel(it.id)}>
                  Αφαίρεση
                </button>
              </div>
            {:else if it.status === 'error'}
              <div class="row-actions">
                <button class="btn btn-sm" onclick={() => queue.retryItem(it.id)}>Ξανά</button>
                <button class="btn btn-sm btn-danger" onclick={() => queue.discard(it.id)}>Διαγραφή</button>
              </div>
            {:else if isStuck(it)}
              <div class="row-actions">
                <button class="btn btn-sm" onclick={() => queue.retryItem(it.id)}>Ξανά</button>
                <button class="btn btn-sm btn-danger"
                        onclick={() => confirm('Η φωτογραφία θα διαγραφεί και δεν θα σταλεί. Σίγουρα;') && queue.cancel(it.id)}>
                  Άκυρο
                </button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .thumb-placeholder {
    background: var(--surface-1, #101119);
    border: 1px solid var(--line);
  }

  .thumb-gone {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--danger-soft);
    color: var(--danger);
    font-weight: 700;
  }

  .last-done {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.55rem 0.7rem;
    margin-bottom: 1rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
  }

  .last-done img {
    width: 38px;
    height: 38px;
    object-fit: cover;
    border-radius: var(--r-input);
    flex: none;
  }

  .last-done div {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .last-name {
    font-size: 0.82rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .last-done .hint {
    font-size: 0.74rem;
  }

  .doctor {
    margin-bottom: 1.25rem;
  }

  .doctor-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.9rem;
  }

  .doctor-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }

  .doctor-list li {
    display: flex;
    gap: 0.7rem;
    align-items: flex-start;
  }

  .doctor-list li > div {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .doctor-list strong {
    font-size: 0.9rem;
  }

  .doctor-log {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--line);
  }

  .log-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.6rem 0;
  }

  .log-view {
    max-height: 40vh;
    overflow: auto;
    margin: 0;
    padding: 0.6rem;
    border-radius: 0.6rem;
    background: var(--surface-1, #101119);
    border: 1px solid var(--line);
    color: var(--muted);
    font-size: 0.7rem;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .doctor-format {
    margin-top: 1.1rem;
    padding-top: 1.1rem;
    border-top: 1px solid var(--line);
  }

  .setting-label {
    display: block;
    font-size: 0.82rem;
    color: var(--text-dim);
    margin-bottom: 0.45rem;
  }

  .seg {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: var(--r-pill);
    overflow: hidden;
    margin-bottom: 0.5rem;
  }

  .seg-btn {
    font: inherit;
    font-size: 0.85rem;
    color: var(--text-dim);
    background: var(--surface);
    border: 0;
    padding: 0.4rem 0.95rem;
    cursor: pointer;
  }

  .seg-btn.on {
    background: var(--accent-strong);
    color: #fff;
  }

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
