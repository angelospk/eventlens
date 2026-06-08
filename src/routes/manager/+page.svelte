<script lang="ts">
  import { config } from '$lib/config';
  import { fetchList, downloadPhoto } from '$lib/manager-client';
  import type { PhotoListItem } from '$lib/types';

  // Local YYYY-MM-DD (avoids UTC off-by-one).
  function today(): string {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  let passcode = $state('');
  let loggedIn = $state(false);
  let date = $state(today());
  let photos = $state<PhotoListItem[]>([]);
  let loading = $state(false);
  let error = $state('');

  async function loadList() {
    loading = true;
    error = '';
    try {
      photos = await fetchList({ workerUrl: config.workerUrl, passcode }, date);
    } catch (e) {
      error = String(e).includes('401') ? 'Λάθος κωδικός.' : 'Σφάλμα δικτύου — δοκίμασε ξανά.';
      photos = [];
    } finally {
      loading = false;
    }
  }

  function login() {
    loggedIn = true;
    loadList();
  }

  async function onDownload(item: PhotoListItem) {
    try {
      await downloadPhoto(item);
    } catch {
      error = 'Αποτυχία κατεβάσματος.';
    }
  }
</script>

{#if !loggedIn}
  <form onsubmit={(e) => { e.preventDefault(); login(); }}>
    <input type="password" bind:value={passcode} placeholder="Manager passcode" aria-label="Manager passcode" />
    <button type="submit">Είσοδος</button>
  </form>
{:else}
  <label>
    Ημερομηνία:
    <input type="date" bind:value={date} onchange={loadList} />
  </label>
  {#if error}<p style="color:red">{error}</p>{/if}
  {#if loading}
    <p>Φόρτωση…</p>
  {:else if photos.length === 0}
    <p>Καμία φωτογραφία για αυτή την ημερομηνία.</p>
  {:else}
    <p>{photos.length} φωτογραφίες</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px">
      {#each photos as p (p.id)}
        <button type="button" onclick={() => onDownload(p)} title={`Κατέβασμα ${p.original_name ?? p.id}`}
                style="border:none;background:none;cursor:pointer;padding:0">
          <img src={p.public_url} alt={p.original_name ?? p.id} loading="lazy"
               style="width:100%;height:160px;object-fit:cover;border-radius:4px" />
        </button>
      {/each}
    </div>
  {/if}
{/if}
