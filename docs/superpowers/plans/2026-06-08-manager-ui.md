# Manager UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manager logs in with a separate manager passcode, picks an event date, sees a grid of that night's processed photos, and downloads any of them with the original filename.

**Architecture:** New `/manager` route in the existing static SvelteKit app. A new `GET /list` endpoint on the existing Cloudflare Worker (gated by a new `MANAGER_PASSCODE` secret) reads photo metadata from D1; images are served from the public R2 URLs. Download is done by fetching the public object as a blob (requires adding GET to the R2 bucket CORS).

**Tech Stack:** bun, SvelteKit (Svelte 5 runes), TypeScript, Cloudflare Worker, D1, R2. Test runner `bun test`.

---

## Context for the implementer

This builds on sub-project 1 (already deployed). Relevant existing facts:
- `worker/src/index.ts` already has `/sign` and `/meta`, a `cors(env)` helper, and a `json(o, env, status)` helper. There is currently a **global** photographer-passcode check near the top of `fetch()` — this plan restructures auth to per-route so `/list` can use the manager passcode instead.
- D1 table `photos(id, r2_key, public_url, event_date, original_name, width, height, bytes, status, created_at)`; `status` is `'confirmed'` after `/meta`.
- `src/lib/r2-client.ts` is the existing pattern for an injectable HTTP client (`fetchImpl` dependency) — mirror it.
- Svelte 5 runes mode: use `$state`/`$derived`, `onclick`/`onchange`/`onsubmit` (NOT `on:` with modifiers); call `e.preventDefault()` manually.
- `config.workerUrl` (from `src/lib/config.ts`) is the Worker base URL.

---

## File Structure

```
src/lib/types.ts              # + PhotoListItem
src/lib/manager-client.ts     # fetchList() [tested] + downloadPhoto() [browser-only]
src/routes/manager/+page.svelte  # login + date picker + grid + download
worker/src/index.ts           # + GET /list, per-route auth, CORS (GET + x-manager-passcode)
tests/manager-client.test.ts  # fetchList tests
worker/DEPLOY.md              # + manager deploy deltas
```

---

## Task 1: Add `PhotoListItem` type

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Append the type**

Add to the end of `src/lib/types.ts`:
```ts
// Returned by GET /list — one confirmed photo's metadata for the manager grid.
export interface PhotoListItem {
  id: string;
  public_url: string;
  original_name: string;
  width: number;
  height: number;
  bytes: number;
  created_at: string;
}
```

- [ ] **Step 2: Type-check**

Run: `bun run check`
Expected: no new type errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts && git commit -m "feat: PhotoListItem type for manager list"
```

---

## Task 2: Worker `GET /list` + per-route auth + CORS

**Files:**
- Modify: `worker/src/index.ts`

- [ ] **Step 1: Replace the whole `worker/src/index.ts` with the version below**

> FIRST diff the version below against the current `worker/src/index.ts` to confirm the only differences are the intended ones (no existing route/validation silently dropped). The snippet IS the complete intended file — but verify before overwriting.

The changes vs. current: add `MANAGER_PASSCODE` to `Env`; `cors()` allows `GET` and the `x-manager-passcode` header; the global photographer-passcode guard is removed and auth is applied **per route** (`/sign` and `/meta` require `x-passcode`; `/list` requires `x-manager-passcode`); add the `/list` handler.

```ts
import { AwsClient } from 'aws4fetch';

interface Env {
  DB: D1Database;
  PASSCODE: string;
  MANAGER_PASSCODE: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  PUBLIC_BASE: string;
  ALLOWED_ORIGIN: string; // exact deployed app origin, e.g. https://user.github.io
}

function cors(env: Env) {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-passcode, x-manager-passcode',
    'vary': 'origin'
  };
}

const json = (o: unknown, env: Env, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(env) } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    const url = new URL(req.url);
    const isPhotographer = req.headers.get('x-passcode') === env.PASSCODE;
    const isManager = req.headers.get('x-manager-passcode') === env.MANAGER_PASSCODE;

    // /sign — photographer only. Validate, record a pending row (server owns key+public_url), return signed PUT URL.
    if (url.pathname === '/sign' && req.method === 'POST') {
      if (!isPhotographer) return json({ error: 'unauthorized' }, env, 401);
      const { id, eventDate, originalName } = await req.json<{ id: string; eventDate: string; originalName?: string }>();
      if (!/^[\w-]{8,}$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return json({ error: 'bad input' }, env, 400);

      const key = `events/${eventDate}/${id}.avif`;
      const publicUrl = `${env.PUBLIC_BASE}/${key}`;

      const insertRes = await env.DB.prepare(
        `INSERT OR IGNORE INTO photos (id, r2_key, public_url, event_date, original_name, status)
         VALUES (?,?,?,?,?,'pending')`
      ).bind(id, key, publicUrl, eventDate, originalName ?? null).run();

      if ((insertRes.meta.changes ?? 0) === 0) {
        const existing = await env.DB.prepare(`SELECT status FROM photos WHERE id = ?`)
          .bind(id).first<{ status: string }>();
        if (existing?.status === 'confirmed') return json({ error: 'already confirmed' }, env, 409);
      }

      const target = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}`;
      const client = new AwsClient({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        service: 's3',
        region: 'auto'
      });
      const signed = await client.sign(
        new Request(`${target}?X-Amz-Expires=3600`, { method: 'PUT', headers: { 'content-type': 'image/avif' } }),
        { aws: { signQuery: true } }
      );
      return json({ uploadUrl: signed.url, publicUrl, key }, env);
    }

    // /meta — photographer only. Confirm an existing PENDING row; cannot inject key/url/date
    // and cannot overwrite an already-confirmed photo (WHERE ... status='pending').
    if (url.pathname === '/meta' && req.method === 'POST') {
      if (!isPhotographer) return json({ error: 'unauthorized' }, env, 401);
      const m = await req.json<{ id: string; original_name?: string; width: number; height: number; bytes: number }>();
      if (!/^[\w-]{8,}$/.test(m.id)) return json({ error: 'bad input' }, env, 400);
      if (![m.width, m.height, m.bytes].every((n) => Number.isFinite(n) && n > 0)) return json({ error: 'bad input' }, env, 400);
      const res = await env.DB.prepare(
        `UPDATE photos SET width=?, height=?, bytes=?, original_name=COALESCE(?, original_name), status='confirmed'
         WHERE id=? AND status='pending'`
      ).bind(m.width, m.height, m.bytes, m.original_name ?? null, m.id).run();
      if ((res.meta.changes ?? 0) === 0) return json({ error: 'unknown or already-confirmed id' }, env, 404);
      return json({ ok: true }, env);
    }

    // /list — manager only. Confirmed photos for one event date.
    if (url.pathname === '/list' && req.method === 'GET') {
      if (!isManager) return json({ error: 'unauthorized' }, env, 401);
      const date = url.searchParams.get('date') ?? '';
      // Syntactic shape AND a real calendar date (rejects e.g. 9999-99-99).
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return json({ error: 'bad input' }, env, 400);
      const { results } = await env.DB.prepare(
        `SELECT id, public_url, original_name, width, height, bytes, created_at
         FROM photos WHERE event_date = ? AND status = 'confirmed' ORDER BY created_at`
      ).bind(date).all();
      return json({ photos: results ?? [] }, env);
    }

    return json({ error: 'not found' }, env, 404);
  }
};
```

- [ ] **Step 2: Type-check the worker**

Run: `bunx tsc -p worker/tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Confirm app tests still pass**

Run: `bun test`
Expected: existing 6 tests still pass (worker file isn't a test target).

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.ts && git commit -m "feat: worker GET /list with manager passcode + per-route auth"
```

---

## Task 3: `manager-client.fetchList` (TDD)

**Files:**
- Create: `src/lib/manager-client.ts`
- Test: `tests/manager-client.test.ts`

- [ ] **Step 1: Write the failing test — `tests/manager-client.test.ts`**

```ts
import { test, expect, mock } from 'bun:test';
import { fetchList } from '../src/lib/manager-client';

test('GETs /list with date query + manager passcode header, returns photos', async () => {
  let seenUrl = '';
  let seenHeader: string | null = null;
  const fakeFetch = mock(async (url: string, opts: any) => {
    seenUrl = url;
    seenHeader = opts?.headers?.['x-manager-passcode'] ?? null;
    return new Response(JSON.stringify({ photos: [{ id: 'a', public_url: 'u', original_name: 'p.jpg', width: 1, height: 2, bytes: 3, created_at: 't' }] }));
  });
  const photos = await fetchList(
    { workerUrl: 'https://wkr', passcode: 'm-secret', fetchImpl: fakeFetch as any },
    '2026-06-08'
  );
  expect(seenUrl).toBe('https://wkr/list?date=2026-06-08');
  expect(seenHeader).toBe('m-secret');
  expect(photos.length).toBe(1);
  expect(photos[0].id).toBe('a');
});

test('throws on non-200', async () => {
  const fakeFetch = mock(async () => new Response('{"error":"unauthorized"}', { status: 401 }));
  await expect(
    fetchList({ workerUrl: 'https://wkr', passcode: 'bad', fetchImpl: fakeFetch as any }, '2026-06-08')
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run test, verify it FAILS** (`fetchList` not defined).

Run: `bun test tests/manager-client.test.ts`

- [ ] **Step 3: Implement — `src/lib/manager-client.ts`**

```ts
import type { PhotoListItem } from './types';

export interface ManagerDeps {
  workerUrl: string;
  passcode: string;
  fetchImpl?: typeof fetch;
}

export async function fetchList(deps: ManagerDeps, date: string): Promise<PhotoListItem[]> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(`${deps.workerUrl}/list?date=${date}`, {
    method: 'GET',
    headers: { 'x-manager-passcode': deps.passcode }
  });
  if (!res.ok) throw new Error(`list failed ${res.status}`);
  const body = (await res.json()) as { photos: PhotoListItem[] };
  return body.photos;
}

// Browser-only: fetch the public object as a blob and trigger a download with the
// original base name + .avif extension. Not unit-tested (needs DOM); manual smoke.
export async function downloadPhoto(item: PhotoListItem): Promise<void> {
  const res = await fetch(item.public_url);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  const base = (item.original_name || item.id).replace(/\.[^./]+$/, '');
  a.download = `${base}.avif`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}
```

- [ ] **Step 4: Run test, verify it PASSES** (both tests).

Run: `bun test tests/manager-client.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/lib/manager-client.ts tests/manager-client.test.ts
git commit -m "feat: manager-client fetchList + downloadPhoto"
```

---

## Task 4: Manager UI route

**Files:**
- Create: `src/routes/manager/+page.svelte`

- [ ] **Step 1: Create `src/routes/manager/+page.svelte`**

```svelte
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
    <input type="password" bind:value={passcode} placeholder="Manager passcode" />
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
        <button type="button" onclick={() => onDownload(p)} title={`Κατέβασμα ${p.original_name}`}
                style="border:none;background:none;cursor:pointer;padding:0">
          <img src={p.public_url} alt={p.original_name} loading="lazy"
               style="width:100%;height:160px;object-fit:cover;border-radius:4px" />
        </button>
      {/each}
    </div>
  {/if}
{/if}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `bun run build`
Expected: success (route `/manager` prerendered).

- [ ] **Step 3: Commit**

```bash
git add src/routes/manager/+page.svelte && git commit -m "feat: manager UI route (login, date picker, grid, download)"
```

---

## Task 5: Deploy deltas + docs

**Files:**
- Modify: `worker/DEPLOY.md`

- [ ] **Step 1: Append manager deploy steps to `worker/DEPLOY.md`**

```
## Manager UI (sub-project 2)
# New secret for manager access:
bunx wrangler secret put MANAGER_PASSCODE

# Extend R2 bucket CORS to allow GET (for fetch-to-download) in addition to PUT.
# Write rules to a temp JSON and apply (do not commit the file):
#   { "rules": [ { "allowed": { "origins": ["https://angelospk.github.io"],
#       "methods": ["GET","PUT","HEAD"], "headers": ["content-type"] }, "maxAgeSeconds": 3600 } ] }
bunx wrangler r2 bucket cors set eventlens --file <rules.json>

# Redeploy the worker with the new /list endpoint:
bunx wrangler deploy
```

- [ ] **Step 2: Commit**

```bash
git add worker/DEPLOY.md && git commit -m "docs: manager UI deploy deltas"
```

- [ ] **Step 3: Human-run deploy** (needs Cloudflare auth — controller will run these after review)

```bash
bunx wrangler secret put MANAGER_PASSCODE   # interactive; user picks the value
# update R2 CORS to add GET/HEAD (see DEPLOY.md)
bunx wrangler deploy
```

- [ ] **Step 4: Manual end-to-end smoke checklist** (after deploy)

  - `GET /list?date=…` with **wrong** manager passcode → `401`.
  - correct manager passcode → only `confirmed` photos for that date.
  - `GET /list?date=9999-99-99` → `400`.
  - `/sign` and `/meta` still reject wrong/missing **photographer** passcode (regression).
  - On deployed `/manager`: grid renders, clicking a photo downloads the blob (proves R2 GET CORS).

---

## Self-Review notes

- **Spec coverage:** manager passcode auth → Task 2 (`isManager`, `MANAGER_PASSCODE`); `GET /list` confirmed-only by date → Task 2; `PhotoListItem` → Task 1; `fetchList` + `downloadPhoto` → Task 3; `/manager` route grid+download → Task 4; R2 CORS GET + secret + deploy → Task 5. All covered.
- **Auth restructure:** the existing global `x-passcode` guard is removed and replaced with per-route checks so `/list` is reachable by managers without the photographer passcode. `/sign` and `/meta` keep photographer-only auth.
- **Type consistency:** `PhotoListItem` (Task 1) is used by `fetchList` (Task 3) and the route (Task 4); the D1 SELECT column list in `/list` (Task 2) matches `PhotoListItem` fields exactly.
- **Known limitation:** grid loads full AVIF objects (no separate thumbnails) with `loading="lazy"` — acceptable per spec; revisit for very large nights. `downloadPhoto` is browser-only (no unit test); manual smoke.
```
