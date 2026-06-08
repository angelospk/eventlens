<script lang="ts">
  import { onMount } from 'svelte';
  import { v4 as uuid } from 'uuid';
  import { config } from '$lib/config';
  import { IdbStore } from '$lib/idb-store';
  import { UploadQueue } from '$lib/upload-queue';
  import { makeR2Uploader } from '$lib/r2-client';
  import type { QueueItem } from '$lib/types';

  let passcode = $state('');
  let loggedIn = $state(false);
  let items = $state<QueueItem[]>([]);
  let queue: UploadQueue;
  let store: IdbStore;

  // Local YYYY-MM-DD (avoids UTC off-by-one for late-night Athens uploads).
  function today(): string {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  async function refresh() { items = await store.all(); }

  function login() {
    store = new IdbStore();
    const uploader = makeR2Uploader({ workerUrl: config.workerUrl, passcode });
    queue = new UploadQueue(store, uploader, config.retry, refresh);
    loggedIn = true;
    refresh();
    queue.drain(); // resume anything left from a previous session
  }

  async function onPick(e: Event) {
    const files = (e.target as HTMLInputElement).files;
    if (!files) return;
    for (const file of Array.from(files)) {
      const item: QueueItem = {
        id: uuid(), file, originalName: file.name, eventDate: today(),
        status: 'pending', attempts: 0
      };
      await queue.enqueue(item);
    }
    await refresh();
    queue.drain();
  }

  onMount(() => {
    const on = () => queue?.drain();
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  });

  // done = items with status 'done'; queue removes successful items, so this is usually 0 (MVP acceptable)
  const done = $derived(items.filter((i) => i.status === 'done').length);
</script>

{#if !loggedIn}
  <form onsubmit={(e) => { e.preventDefault(); login(); }}>
    <input type="password" bind:value={passcode} placeholder="Passcode" />
    <button type="submit">Είσοδος</button>
  </form>
{:else}
  <input type="file" accept="image/*" multiple onchange={onPick} />
  <p>{items.length - done} σε εξέλιξη · {done} ολοκληρώθηκαν</p>
  <ul>
    {#each items as it (it.id)}
      <li>{it.originalName} — {it.status}{#if it.status === 'error'} ⚠ {it.lastError}{/if}</li>
    {/each}
  </ul>
{/if}
