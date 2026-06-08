# Capture + Process + Upload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ένας φωτογράφος διαλέγει φωτογραφίες σε static web app· κάθε μία παίρνει logo (ήσυχη γωνία) + brand φίλτρο, κωδικοποιείται σε AVIF, και ανεβαίνει αξιόπιστα σε Cloudflare R2 με metadata στο D1, μέσα από ανθεκτική ουρά που δεν χάνει τίποτα.

**Architecture:** Static SvelteKit (adapter-static) κάνει όλη την επεξεργασία στον browser. Ένας Cloudflare Worker (με aws4fetch) ελέγχει passcode και εκδίδει presigned R2 PUT URLs + γράφει metadata στο D1. Persistent IndexedDB ουρά ανεβάζει σειριακά με exponential backoff. Τα core modules σχεδιάζονται με injectable dependencies ώστε να ελέγχονται με `bun test` χωρίς browser.

**Tech Stack:** bun, SvelteKit, @sveltejs/adapter-static v3, TypeScript, @jsquash/avif, Cloudflare Worker + aws4fetch, Cloudflare R2, Cloudflare D1, wrangler, fake-indexeddb (tests).

---

## File Structure

```
eventlens/
  package.json
  svelte.config.js              # adapter-static
  vite.config.ts
  tsconfig.json
  bunfig.toml                   # test preload (fake-indexeddb)
  wrangler.toml                 # worker + R2 + D1 bindings
  src/
    lib/
      config.ts                 # brand/logo/filter/avif/api constants
      quiet-corner.ts           # pure: busiest→quietest corner detection
      processor.ts              # filter + logo + AVIF encode (browser)
      upload-queue.ts           # persistent serial queue + backoff (injectable deps)
      idb-store.ts              # IndexedDB impl of QueueStore
      r2-client.ts              # /sign → PUT → /meta (the Uploader impl)
      types.ts                  # shared types
    routes/
      +layout.svelte
      +page.svelte              # login + picker + queue UI
  worker/
    src/index.ts                # /sign + /meta endpoints
    migrations/0001_init.sql    # photos table
  tests/
    quiet-corner.test.ts
    upload-queue.test.ts
    r2-client.test.ts
  static/
    logo.png                    # placeholder brand logo (user replaces)
```

**Responsibilities:**
- `quiet-corner.ts` — pure pixel math, no DOM. Testable in bun.
- `upload-queue.ts` — orchestration with `QueueStore` + `Uploader` interfaces injected. Testable with in-memory fakes.
- `idb-store.ts` — the production `QueueStore` (IndexedDB). Tested with fake-indexeddb.
- `r2-client.ts` — the production `Uploader` (HTTP to Worker). Tested with fetch stub.
- `processor.ts` — browser-only (canvas + WASM); thin, exercised in-browser, pure helpers unit-tested.
- `worker/src/index.ts` — the only backend; passcode gate + presign + D1 insert.

---

## Task 0: Project scaffold

**Files:**
- Create: `package.json`, `svelte.config.js`, `vite.config.ts`, `tsconfig.json`, `bunfig.toml`, `src/routes/+layout.svelte`, `src/routes/+page.svelte`, `src/app.html`, `static/.gitkeep`

- [ ] **Step 1: Scaffold SvelteKit + install deps with bun**

```bash
cd /Users/harold/projects/eventlens
bun create svelte@latest . --template skeleton --types ts --no-add-ons 2>/dev/null || true
bun add -d @sveltejs/adapter-static fake-indexeddb
bun add @jsquash/avif uuid
```

If `bun create svelte` is interactive/unavailable, create files manually per following steps.

- [ ] **Step 2: `package.json` scripts**

```json
{
  "name": "eventlens",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "test": "bun test",
    "check": "svelte-check --tsconfig ./tsconfig.json"
  }
}
```

- [ ] **Step 3: `svelte.config.js` with adapter-static**

```js
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const base = process.env.BASE_PATH ?? '';

export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ fallback: 'index.html' }),
    paths: { base },
    prerender: { entries: ['*'] }
  }
};
```

- [ ] **Step 4: `bunfig.toml` so IndexedDB exists in tests**

```toml
[test]
preload = ["fake-indexeddb/auto"]
```

- [ ] **Step 5: Verify dev server boots**

Run: `bun run build`
Expected: build succeeds, emits `build/` with `index.html`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold SvelteKit static + bun + deps"
```

---

## Task 1: Shared types + config

**Files:**
- Create: `src/lib/types.ts`, `src/lib/config.ts`

- [ ] **Step 1: `src/lib/types.ts`**

```ts
export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export interface Pixels {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
}

export type ItemStatus =
  | 'pending'
  | 'processing'
  | 'uploading'
  | 'done'
  | 'error';

export interface QueueItem {
  id: string;            // uuid, also the R2 filename stem
  file: Blob;            // source file (kept until upload confirmed)
  originalName: string;
  eventDate: string;     // YYYY-MM-DD
  status: ItemStatus;
  attempts: number;
  lastError?: string;
  // populated after processing:
  avif?: Blob;
  width?: number;
  height?: number;
  bytes?: number;
}

export interface Processed { avif: Blob; width: number; height: number; bytes: number; }

// Sent to /meta. The server already knows r2_key/public_url from /sign;
// the client only confirms the upload + reports dimensions.
export interface PhotoMeta {
  id: string;
  original_name: string;
  width: number;
  height: number;
  bytes: number;
}

// Returned by /sign.
export interface SignResult { uploadUrl: string; publicUrl: string; key: string; }
```

- [ ] **Step 2: `src/lib/config.ts`**

```ts
export const config = {
  // Cloudflare Worker base URL (set per environment via PUBLIC env in real deploy)
  workerUrl: import.meta.env?.VITE_WORKER_URL ?? 'http://localhost:8787',
  // logo path is resolved against the SvelteKit base path at call sites (see processor):
  logoFile: 'logo.png',
  avif: { quality: 70, effort: 5 },
  // Brand color grade applied via canvas filter string:
  filter: 'contrast(1.05) saturate(1.12) brightness(1.02)',
  // Logo sizing/padding as fraction of the image's short edge:
  logoWidthFraction: 0.18,
  logoPaddingFraction: 0.03,
  // Optional downscale cap (disabled by default to preserve resolution):
  maxLongEdge: 0 as number, // 0 = no cap
  // Upload retry policy:
  retry: { baseMs: 1000, maxMs: 30000, maxAttempts: 8 }
};
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts src/lib/config.ts && git commit -m "feat: shared types and config"
```

---

## Task 2: quiet-corner (TDD)

**Files:**
- Create: `src/lib/quiet-corner.ts`
- Test: `tests/quiet-corner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test';
import { quietestCorner } from '../src/lib/quiet-corner';
import type { Pixels } from '../src/lib/types';

// Build a WxH RGBA image: noisy everywhere except one flat corner.
function makeImage(w: number, h: number, flat: 'tl' | 'tr' | 'bl' | 'br'): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // high-variance checkerboard noise
      const v = ((x * 37 + y * 53) % 2) * 255;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  // flatten the chosen corner quadrant to a constant gray
  const halfW = Math.floor(w / 2), halfH = Math.floor(h / 2);
  const xs = flat === 'tl' || flat === 'bl' ? 0 : halfW;
  const ys = flat === 'tl' || flat === 'tr' ? 0 : halfH;
  for (let y = ys; y < ys + halfH; y++) {
    for (let x = xs; x < xs + halfW; x++) {
      const i = (y * w + x) * 4;
      data[i] = 128; data[i + 1] = 128; data[i + 2] = 128; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

test('detects the flat corner as quietest', () => {
  for (const c of ['tl', 'tr', 'bl', 'br'] as const) {
    expect(quietestCorner(makeImage(40, 40, c))).toBe(c);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/quiet-corner.test.ts`
Expected: FAIL — `quietestCorner` is not defined / module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Corner, Pixels } from './types';

function luminance(data: Uint8ClampedArray, i: number): number {
  return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
}

// Variance of luminance over a rectangular region = "busyness".
function regionVariance(px: Pixels, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0, sumSq = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const l = luminance(px.data, (y * px.width + x) * 4);
      sum += l; sumSq += l * l; n++;
    }
  }
  if (n === 0) return Infinity;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function quietestCorner(px: Pixels, sampleFraction = 0.35): Corner {
  const sw = Math.max(1, Math.floor(px.width * sampleFraction));
  const sh = Math.max(1, Math.floor(px.height * sampleFraction));
  const regions: Record<Corner, [number, number, number, number]> = {
    tl: [0, 0, sw, sh],
    tr: [px.width - sw, 0, px.width, sh],
    bl: [0, px.height - sh, sw, px.height],
    br: [px.width - sw, px.height - sh, px.width, px.height]
  };
  let best: Corner = 'br';
  let bestVar = Infinity;
  for (const c of ['tl', 'tr', 'bl', 'br'] as Corner[]) {
    const v = regionVariance(px, ...regions[c]);
    if (v < bestVar) { bestVar = v; best = c; }
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/quiet-corner.test.ts`
Expected: PASS (4 corners).

- [ ] **Step 5: Commit**

```bash
git add src/lib/quiet-corner.ts tests/quiet-corner.test.ts
git commit -m "feat: quiet-corner detection with tests"
```

---

## Task 3: upload-queue with injectable deps (TDD)

**Files:**
- Create: `src/lib/upload-queue.ts`
- Test: `tests/upload-queue.test.ts`

The queue depends on two interfaces so it can be tested without browser/network:
`QueueStore` (persistence) and `Uploader` (does process+upload for one item).

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test';
import { UploadQueue } from '../src/lib/upload-queue';
import type { QueueItem } from '../src/lib/types';

class MemStore {
  items = new Map<string, QueueItem>();
  async add(it: QueueItem) { this.items.set(it.id, { ...it }); }
  async update(id: string, patch: Partial<QueueItem>) {
    this.items.set(id, { ...this.items.get(id)!, ...patch });
  }
  async remove(id: string) { this.items.delete(id); }
  async all() { return [...this.items.values()]; }
}

function item(id: string): QueueItem {
  return { id, file: new Blob(['x']), originalName: `${id}.jpg`,
           eventDate: '2026-06-08', status: 'pending', attempts: 0 };
}

test('retries a failing upload then succeeds, no duplicate', async () => {
  const store = new MemStore();
  let calls = 0;
  const uploader = {
    async run(_it: QueueItem) { calls++; if (calls < 3) throw new Error('net'); }
  };
  const q = new UploadQueue(store, uploader, { baseMs: 1, maxMs: 4, maxAttempts: 8 });
  await q.enqueue(item('a'));
  await q.drain(); // process until queue empty or all failed
  expect(calls).toBe(3);
  expect((await store.all()).length).toBe(0); // done items removed
});

test('marks error after maxAttempts and keeps item for manual retry', async () => {
  const store = new MemStore();
  const uploader = { async run() { throw new Error('always'); } };
  const q = new UploadQueue(store, uploader, { baseMs: 1, maxMs: 4, maxAttempts: 3 });
  await q.enqueue(item('b'));
  await q.drain();
  const items = await store.all();
  expect(items.length).toBe(1);
  expect(items[0].status).toBe('error');
  expect(items[0].attempts).toBe(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/upload-queue.test.ts`
Expected: FAIL — `UploadQueue` not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { QueueItem } from './types';

export interface QueueStore {
  add(item: QueueItem): Promise<void>;
  update(id: string, patch: Partial<QueueItem>): Promise<void>;
  remove(id: string): Promise<void>;
  all(): Promise<QueueItem[]>;
}

export interface Uploader {
  // Process (logo+filter+AVIF) and upload one item. Throws on failure.
  run(item: QueueItem): Promise<void>;
}

export interface RetryPolicy { baseMs: number; maxMs: number; maxAttempts: number; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Runnable = waiting to be tried, or left mid-flight by a crash/reload.
// 'error' items are NOT auto-retried (manual retry only); 'done' are removed.
function isRunnable(i: QueueItem, maxAttempts: number): boolean {
  return (i.status === 'pending' || i.status === 'uploading') && i.attempts < maxAttempts;
}

export class UploadQueue {
  private running = false;
  private dirty = false;
  constructor(
    private store: QueueStore,
    private uploader: Uploader,
    private retry: RetryPolicy,
    private onChange: () => void = () => {}
  ) {}

  async enqueue(item: QueueItem) {
    await this.store.add(item);
    this.onChange();
  }

  // Cross-tab single-flight via Web Locks (no-op in non-browser test env).
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = (globalThis as any).navigator?.locks;
    return locks?.request ? locks.request('eventlens-upload', fn) : fn();
  }

  /** Process runnable items one-by-one until none remain. Safe to call repeatedly. */
  async drain() {
    if (this.running) { this.dirty = true; return; } // re-pass after current loop
    await this.withLock(async () => {
      this.running = true;
      try {
        do {
          this.dirty = false;
          for (;;) {
            const items = await this.store.all();
            const next = items.find((i) => isRunnable(i, this.retry.maxAttempts));
            if (!next) break;
            await this.process(next);
          }
        } while (this.dirty); // an enqueue happened mid-drain → another pass
      } finally {
        this.running = false;
        this.onChange();
      }
    });
  }

  private async process(it: QueueItem) {
    const attempts = it.attempts + 1;
    await this.store.update(it.id, { status: 'uploading', attempts });
    this.onChange();
    try {
      await this.uploader.run(it);
      await this.store.remove(it.id); // success → drop from queue
    } catch (e) {
      const status = attempts >= this.retry.maxAttempts ? 'error' : 'pending';
      await this.store.update(it.id, { status, lastError: String(e) });
      this.onChange();
      if (status === 'pending') {
        const backoff = Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** (attempts - 1));
        await sleep(backoff);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/upload-queue.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/upload-queue.ts tests/upload-queue.test.ts
git commit -m "feat: resilient upload queue with retry/backoff"
```

---

## Task 4: IndexedDB store (production QueueStore)

**Files:**
- Create: `src/lib/idb-store.ts`
- Test: `tests/idb-store.test.ts`

- [ ] **Step 1: Write the failing test** (uses fake-indexeddb via bunfig preload)

```ts
import { test, expect } from 'bun:test';
import { IdbStore } from '../src/lib/idb-store';
import type { QueueItem } from '../src/lib/types';

const it = (id: string): QueueItem => ({
  id, file: new Blob(['x']), originalName: 'a.jpg', eventDate: '2026-06-08',
  status: 'pending', attempts: 0
});

test('persists, updates and removes items', async () => {
  const store = new IdbStore('test-db-1');
  await store.add(it('a'));
  await store.update('a', { status: 'done' });
  let all = await store.all();
  expect(all.length).toBe(1);
  expect(all[0].status).toBe('done');
  await store.remove('a');
  all = await store.all();
  expect(all.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/idb-store.test.ts`
Expected: FAIL — `IdbStore` not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { QueueItem } from './types';
import type { QueueStore } from './upload-queue';

const STORE = 'queue';

function open(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbStore implements QueueStore {
  private dbp: Promise<IDBDatabase>;
  constructor(dbName = 'eventlens-queue') { this.dbp = open(dbName); }

  async add(item: QueueItem) { await tx(await this.dbp, 'readwrite', (s) => s.put(item)); }

  // Read-modify-write inside ONE readwrite transaction to avoid lost updates
  // (e.g. processor writing avif/bytes racing with retry writing status/attempts).
  async update(id: string, patch: Partial<QueueItem>) {
    const db = await this.dbp;
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      const s = t.objectStore(STORE);
      const getReq = s.get(id);
      getReq.onsuccess = () => {
        const cur = getReq.result as QueueItem | undefined;
        if (!cur) return; // item already removed
        s.put({ ...cur, ...patch });
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  async remove(id: string) { await tx(await this.dbp, 'readwrite', (s) => s.delete(id)); }

  async all() {
    return tx<QueueItem[]>(await this.dbp, 'readonly', (s) => s.getAll() as IDBRequest<QueueItem[]>);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/idb-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/idb-store.ts tests/idb-store.test.ts
git commit -m "feat: IndexedDB-backed queue store"
```

---

## Task 5: processor (browser: filter + logo + AVIF)

**Files:**
- Create: `src/lib/processor.ts`

Browser-only (canvas + WASM). No bun unit test (needs DOM/canvas); verified in-browser in Task 8. Keep it thin.

- [ ] **Step 1: Implement processor**

```ts
import { encode as encodeAvif } from '@jsquash/avif';
import { base } from '$app/paths';
import { quietestCorner } from './quiet-corner';
import { config } from './config';
import type { Pixels, Processed } from './types';

async function loadLogo(): Promise<ImageBitmap> {
  const res = await fetch(`${base}/${config.logoFile}`);
  return createImageBitmap(await res.blob());
}

function cornerXY(corner: string, W: number, H: number, lw: number, lh: number, pad: number) {
  const x = corner === 'tl' || corner === 'bl' ? pad : W - lw - pad;
  const y = corner === 'tl' || corner === 'tr' ? pad : H - lh - pad;
  return { x, y };
}

export async function processImage(file: Blob): Promise<Processed> {
  const src = await createImageBitmap(file);
  let W = src.width, H = src.height;

  // optional downscale cap
  const cap = config.maxLongEdge;
  if (cap > 0 && Math.max(W, H) > cap) {
    const s = cap / Math.max(W, H);
    W = Math.round(W * s); H = Math.round(H * s);
  }

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d')!;
  ctx.filter = config.filter;                 // brand color grade
  ctx.drawImage(src, 0, 0, W, H);
  ctx.filter = 'none';

  // pick quiet corner from current pixels
  const id = ctx.getImageData(0, 0, W, H);
  const px: Pixels = { data: id.data, width: W, height: H };
  const corner = quietestCorner(px);

  // draw logo
  const logo = await loadLogo();
  const shortEdge = Math.min(W, H);
  const lw = Math.round(shortEdge * config.logoWidthFraction);
  const lh = Math.round((logo.height / logo.width) * lw);
  const pad = Math.round(shortEdge * config.logoPaddingFraction);
  const { x, y } = cornerXY(corner, W, H, lw, lh, pad);
  ctx.drawImage(logo, x, y, lw, lh);

  // encode AVIF
  const finalId = ctx.getImageData(0, 0, W, H);
  const buf = await encodeAvif(finalId, { quality: config.avif.quality, effort: config.avif.effort });
  const avif = new Blob([buf], { type: 'image/avif' });
  return { avif, width: W, height: H, bytes: avif.size };
}
```

- [ ] **Step 2: Type-check**

Run: `bun run check`
Expected: no type errors in `processor.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/processor.ts && git commit -m "feat: image processor (filter+logo+AVIF)"
```

---

## Task 6: r2-client (production Uploader, TDD)

**Files:**
- Create: `src/lib/r2-client.ts`
- Test: `tests/r2-client.test.ts`

- [ ] **Step 1: Write the failing test** (stubs `fetch` and `processImage`)

```ts
import { test, expect, mock } from 'bun:test';
import { makeR2Uploader } from '../src/lib/r2-client';
import type { QueueItem } from '../src/lib/types';

const it: QueueItem = {
  id: 'abc', file: new Blob(['x']), originalName: 'p.jpg', eventDate: '2026-06-08',
  status: 'pending', attempts: 0
};

test('calls /sign, PUTs blob, then POSTs /meta with correct shape', async () => {
  const calls: string[] = [];
  const fakeFetch = mock(async (url: string, opts: any) => {
    calls.push(`${opts?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/sign')) {
      return new Response(JSON.stringify({ uploadUrl: 'https://r2/put-here', publicUrl: 'https://cdn/abc.avif', key: 'events/2026-06-08/abc.avif' }));
    }
    return new Response('{}', { status: 200 });
  });
  const fakeProcess = async () => ({ avif: new Blob(['avif']), width: 10, height: 20, bytes: 4 });

  const uploader = makeR2Uploader({
    workerUrl: 'https://wkr',
    passcode: 'secret',
    fetchImpl: fakeFetch as any,
    process: fakeProcess
  });
  await uploader.run(it);

  expect(calls[0]).toBe('POST https://wkr/sign');
  expect(calls[1]).toBe('PUT https://r2/put-here');
  expect(calls[2]).toBe('POST https://wkr/meta');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/r2-client.test.ts`
Expected: FAIL — `makeR2Uploader` not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Uploader } from './upload-queue';
import type { QueueItem, Processed, PhotoMeta, SignResult } from './types';
import { processImage } from './processor';

export interface R2UploaderDeps {
  workerUrl: string;
  passcode: string;
  fetchImpl?: typeof fetch;
  process?: (file: Blob) => Promise<Processed>;
}

export function makeR2Uploader(deps: R2UploaderDeps): Uploader {
  const f = deps.fetchImpl ?? fetch;
  const proc = deps.process ?? processImage;
  const auth = { 'x-passcode': deps.passcode };

  return {
    async run(item: QueueItem) {
      // 1) Sign FIRST: validates passcode before expensive AVIF work, and the
      //    Worker records a pending row keyed by id (server owns key/public_url).
      const signRes = await f(`${deps.workerUrl}/sign`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id, eventDate: item.eventDate, originalName: item.originalName })
      });
      if (!signRes.ok) throw new Error(`sign failed ${signRes.status}`);
      const { uploadUrl } = (await signRes.json()) as SignResult;

      // 2) Process (logo + filter + AVIF).
      const out = await proc(item.file);

      // 3) PUT to R2. content-type MUST match what was signed exactly.
      const put = await f(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'image/avif' },
        body: out.avif
      });
      if (!put.ok) throw new Error(`put failed ${put.status}`);

      // 4) Confirm metadata. Server already knows key/public_url from /sign;
      //    we only confirm + report dimensions. Idempotent on id.
      const meta: PhotoMeta = {
        id: item.id, original_name: item.originalName,
        width: out.width, height: out.height, bytes: out.bytes
      };
      const metaRes = await f(`${deps.workerUrl}/meta`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(meta)
      });
      if (!metaRes.ok) throw new Error(`meta failed ${metaRes.status}`);
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/r2-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/r2-client.ts tests/r2-client.test.ts
git commit -m "feat: R2 uploader client (sign/put/meta)"
```

---

## Task 7: Cloudflare Worker + D1 migration

**Files:**
- Create: `worker/src/index.ts`, `worker/migrations/0001_init.sql`, `wrangler.toml`

- [ ] **Step 1: Install worker deps**

```bash
bun add aws4fetch
bun add -d wrangler
```

- [ ] **Step 2: `worker/migrations/0001_init.sql`**

```sql
CREATE TABLE IF NOT EXISTS photos (
  id            TEXT PRIMARY KEY,
  r2_key        TEXT NOT NULL,
  public_url    TEXT NOT NULL,
  event_date    TEXT NOT NULL,
  original_name TEXT,
  width         INTEGER,
  height        INTEGER,
  bytes         INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending → confirmed (set by /meta)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_event_date ON photos(event_date);
CREATE INDEX IF NOT EXISTS idx_photos_status ON photos(status);
```

- [ ] **Step 3: `wrangler.toml`**

```toml
name = "eventlens-worker"
main = "worker/src/index.ts"
compatibility_date = "2026-01-01"

[[d1_databases]]
binding = "DB"
database_name = "eventlens"
database_id = "REPLACE_AFTER_CREATE"
migrations_dir = "worker/migrations"

# Secrets (set via `wrangler secret put`):
#   PASSCODE, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
[vars]
R2_BUCKET = "eventlens"
PUBLIC_BASE = "https://REPLACE.r2.dev"            # public bucket / custom domain
ALLOWED_ORIGIN = "https://REPLACE.github.io"      # exact deployed app origin
```

- [ ] **Step 4: `worker/src/index.ts`**

```ts
import { AwsClient } from 'aws4fetch';

interface Env {
  DB: D1Database;
  PASSCODE: string;
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
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-passcode',
    'vary': 'origin'
  };
}

const json = (o: unknown, env: Env, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...cors(env) } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env) });
    if (req.headers.get('x-passcode') !== env.PASSCODE) return json({ error: 'unauthorized' }, env, 401);

    const url = new URL(req.url);

    // /sign — validate, record a pending row (server owns key+public_url), return signed PUT URL.
    if (url.pathname === '/sign' && req.method === 'POST') {
      const { id, eventDate, originalName } = await req.json<{ id: string; eventDate: string; originalName?: string }>();
      if (!/^[\w-]{8,}$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return json({ error: 'bad input' }, env, 400);

      const key = `events/${eventDate}/${id}.avif`;
      const publicUrl = `${env.PUBLIC_BASE}/${key}`;

      // Reserve the row up front. INSERT OR IGNORE so a retried /sign is idempotent.
      await env.DB.prepare(
        `INSERT OR IGNORE INTO photos (id, r2_key, public_url, event_date, original_name, status)
         VALUES (?,?,?,?,?,'pending')`
      ).bind(id, key, publicUrl, eventDate, originalName ?? null).run();

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

    // /meta — confirm an existing pending row; client cannot inject key/url/date.
    if (url.pathname === '/meta' && req.method === 'POST') {
      const m = await req.json<{ id: string; original_name?: string; width: number; height: number; bytes: number }>();
      if (!/^[\w-]{8,}$/.test(m.id)) return json({ error: 'bad input' }, env, 400);
      const res = await env.DB.prepare(
        `UPDATE photos SET width=?, height=?, bytes=?, original_name=COALESCE(?, original_name), status='confirmed'
         WHERE id=?`
      ).bind(m.width, m.height, m.bytes, m.original_name ?? null, m.id).run();
      if ((res.meta.changes ?? 0) === 0) return json({ error: 'unknown id' }, env, 404);
      return json({ ok: true }, env);
    }

    return json({ error: 'not found' }, env, 404);
  }
};
```

- [ ] **Step 5: Create D1 DB + apply migration (requires logged-in wrangler; user runs)**

```bash
bunx wrangler d1 create eventlens          # paste returned database_id into wrangler.toml
bunx wrangler d1 migrations apply eventlens --remote
```
Expected: migration `0001_init` applied; `photos` table exists.

> SAFEGUARD: needs Cloudflare auth (`bunx wrangler login`). If unavailable, note it and continue; deploy steps run later.

- [ ] **Step 6: Commit**

```bash
git add worker wrangler.toml && git commit -m "feat: Cloudflare Worker (sign/meta) + D1 migration"
```

---

## Task 8: UI wiring (login + picker + queue view)

**Files:**
- Modify: `src/routes/+page.svelte`

- [ ] **Step 1: Implement the page**

```svelte
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

  const done = $derived(items.filter((i) => i.status === 'done').length);
</script>

{#if !loggedIn}
  <form on:submit|preventDefault={login}>
    <input type="password" bind:value={passcode} placeholder="Passcode" />
    <button type="submit">Είσοδος</button>
  </form>
{:else}
  <input type="file" accept="image/*" multiple on:change={onPick} />
  <p>{items.length - done} σε εξέλιξη · {done} ολοκληρώθηκαν</p>
  <ul>
    {#each items as it (it.id)}
      <li>{it.originalName} — {it.status}{#if it.status === 'error'} ⚠ {it.lastError}{/if}</li>
    {/each}
  </ul>
{/if}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `bun run build`
Expected: build succeeds.

- [ ] **Step 3: Manual browser smoke (user, after worker deployed)**

Run `bun run dev`, set `VITE_WORKER_URL`, log in with passcode, pick a photo, confirm it reaches `error→done` and appears in R2 + D1.

- [ ] **Step 4: Commit**

```bash
git add src/routes/+page.svelte && git commit -m "feat: upload UI (login, picker, queue view)"
```

---

## Task 9: Deploy config

**Files:**
- Create: `.github/workflows/deploy.yml` (GitHub Pages) — optional if using Cloudflare Pages.

- [ ] **Step 1: GitHub Pages workflow (only if hosting on Pages)**

```yaml
name: deploy
on: { push: { branches: [main] } }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: BASE_PATH="/${GITHUB_REPOSITORY#*/}" bun run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: build }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages }
    steps:
      - uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Deploy the Worker (user, needs Cloudflare auth)**

```bash
bunx wrangler secret put PASSCODE
bunx wrangler secret put R2_ACCOUNT_ID
bunx wrangler secret put R2_ACCESS_KEY_ID
bunx wrangler secret put R2_SECRET_ACCESS_KEY
bunx wrangler deploy
```

- [ ] **Step 3: Configure R2 bucket CORS** (allow browser PUT)

```json
[{ "AllowedOrigins": ["https://REPLACE.github.io"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
```
Use the exact deployed app origin (same as the Worker `ALLOWED_ORIGIN`), not `*`.

- [ ] **Step 4: Commit**

```bash
git add .github && git commit -m "ci: GitHub Pages deploy workflow"
```

---

## Self-Review notes

- **Spec coverage:** logo+filter+AVIF → Task 5; quiet corner → Task 2; resilient queue (retry/backoff/idempotent UUID/offline resume) → Tasks 3,4,8; passcode auth → Tasks 6,7; R2 storage → Tasks 6,7,9; D1 metadata + migration → Task 7; static hosting → Tasks 0,9. All covered.
- **Type consistency:** `QueueStore`/`Uploader` interfaces defined in Task 3, implemented in Tasks 4/6; `Processed`/`PhotoMeta`/`QueueItem` from Task 1 used consistently; `uploader.run()` name matches across queue, tests, and r2-client.
- **Idempotency:** UUID assigned at enqueue (Task 8); `/sign` uses `INSERT OR IGNORE` (retried sign is a no-op); `/meta` is an idempotent `UPDATE` by id. No duplicates on retry.
- **Security (post-Codex):** server owns `r2_key`/`public_url` (client can't inject them); `/sign` reserves a pending row and `/meta` only confirms existing ids; CORS locked to `ALLOWED_ORIGIN`; auth checked before AVIF work (sign-first).
- **Concurrency (post-Codex):** `IdbStore.update` is a single read-modify-write transaction; queue selects only runnable statuses (`pending`/stale `uploading`), never auto-retries `error`; cross-tab double-upload prevented via Web Locks; enqueue-mid-drain closed via `dirty` flag.

### Accepted limitations (deferred, noted not hidden)
- **Orphan reconciliation:** if R2 PUT succeeds but `/meta` never confirms, the row stays `status='pending'`. The queue retries (idempotent), so this self-heals while the item is queued; a periodic "pending older than N" sweep is deferred to a later sub-project.
- **Rate-limiting `/sign`:** not in MVP. A leaked passcode could mint URLs for 1h. Deferred; mitigated by locked CORS + short expiry. Revisit if abuse appears.
- **`processor` unit test:** canvas/WASM are browser-only; covered by manual browser smoke (Task 8 Step 3).
- **IndexedDB quota:** `IdbStore.add` should surface `QuotaExceededError` to the UI ("δεν χωράει — ανέβασε ό,τι υπάρχει πρώτα"); wire this when implementing Task 8.
```
