import { test, expect } from 'bun:test';
import { UploadQueue } from '../src/lib/upload-queue';
import { AlreadyUploadedError, NonRetryableError, classifyStatus } from '../src/lib/errors';
import { makeR2Uploader } from '../src/lib/r2-client';
import type { QueueItem } from '../src/lib/types';

class MemStore {
  items = new Map<string, QueueItem>();
  async add(it: QueueItem) { this.items.set(it.id, { ...it }); }
  async update(id: string, patch: Partial<QueueItem>) {
    const cur = this.items.get(id);
    if (cur) this.items.set(id, { ...cur, ...patch });
  }
  async remove(id: string) { this.items.delete(id); }
  async all() { return [...this.items.values()]; }
}

function item(id: string): QueueItem {
  return {
    id, file: new Blob(['x']), originalName: `${id}.jpg`,
    eventDate: '2026-06-08', status: 'pending', attempts: 0
  };
}

test('a lost response (409 already confirmed) counts as success, not failure', async () => {
  const store = new MemStore();
  let calls = 0;
  const uploader = {
    async run(it: QueueItem) {
      calls++;
      throw new AlreadyUploadedError(it.id);
    }
  };
  const q = new UploadQueue(store, uploader, { baseMs: 1, maxMs: 4, maxAttempts: 8 });
  await q.enqueue(item('a'));
  await q.drain();

  expect(calls).toBe(1); // no reprocessing of a photo the server already has
  expect(await store.all()).toEqual([]); // left the queue
  expect(q.completed).toBe(1); // and counted as uploaded
});

test('a wrong passcode fails once instead of burning the whole backoff ladder', async () => {
  const store = new MemStore();
  let calls = 0;
  const uploader = {
    async run() {
      calls++;
      throw new NonRetryableError('bad passcode', 'unauthorized');
    }
  };
  const q = new UploadQueue(store, uploader, { baseMs: 1000, maxMs: 30000, maxAttempts: 8 });
  await q.enqueue(item('b'));
  await q.drain();

  expect(calls).toBe(1);
  const [stored] = await store.all();
  expect(stored.status).toBe('error');
  expect(stored.attempts).toBe(1);
  expect(stored.nextAttemptAt).toBeUndefined(); // no timer left behind
});

test('retryItem clears the error state and uploads again', async () => {
  const store = new MemStore();
  let failNext = true;
  const uploader = {
    async run() {
      if (failNext) throw new NonRetryableError('nope', 'unauthorized');
    }
  };
  const q = new UploadQueue(store, uploader, { baseMs: 1, maxMs: 4, maxAttempts: 3 });
  await q.enqueue(item('c'));
  await q.drain();
  expect((await store.all())[0].status).toBe('error');

  failNext = false;
  await q.retryItem('c');
  await q.drain();

  expect(await store.all()).toEqual([]);
  expect(q.completed).toBe(1);
});

test('retryAll resets every failed item, leaving healthy ones alone', async () => {
  const store = new MemStore();
  const uploader = { async run() { throw new NonRetryableError('nope', 'bad_request'); } };
  const q = new UploadQueue(store, uploader, { baseMs: 1, maxMs: 4, maxAttempts: 2 });
  await q.enqueue(item('d'));
  await q.enqueue(item('e'));
  await q.drain();
  expect((await store.all()).every((i) => i.status === 'error')).toBe(true);

  await q.retryAll();
  // retryAll kicks off a drain, which fails them again, but each was reset to attempts 0
  // beforehand: the point is that a manual retry is possible at all.
  expect((await store.all()).every((i) => i.attempts <= 1)).toBe(true);
});

test('a store that throws mid-drain does not strand the queue or reject the drain', async () => {
  const store = new MemStore();
  await store.add(item('x'));
  await store.add(item('y'));
  // Writing the 'uploading' marker fails for x only, the way IndexedDB does while a tab is
  // being torn down. y must still upload, and drain() must resolve rather than reject.
  const realUpdate = store.update.bind(store);
  store.update = async (id: string, patch: any) => {
    if (id === 'x' && patch.status === 'uploading') throw new Error('IDB closing');
    return realUpdate(id, patch);
  };

  const uploaded: string[] = [];
  const uploader = { async run(it: QueueItem) { uploaded.push(it.id); } };
  const q = new UploadQueue(store, uploader, { baseMs: 1, maxMs: 4, maxAttempts: 3 });

  await q.drain(); // must not throw, must not spin forever

  expect(uploaded).toEqual(['y']);
  expect((await store.all()).map((i) => i.id)).toEqual(['x']); // x survives for a later try
  expect(q.completed).toBe(1);
});

test('an upload that succeeds is counted even if removing the row fails', async () => {
  const store = new MemStore();
  await store.add(item('z'));
  store.remove = async () => { throw new Error('IDB closing'); };
  const q = new UploadQueue(store, { async run() {} }, { baseMs: 1, maxMs: 4, maxAttempts: 3 });

  await q.drain();

  expect(q.completed).toBe(1);
});

test('uploads run oldest-first regardless of how the store orders rows', async () => {
  const store = new MemStore();
  // Insert deliberately out of order, the way IndexedDB hands back rows sorted by uuid.
  await store.add({ ...item('zulu'), queuedAt: 300 });
  await store.add({ ...item('alpha'), queuedAt: 100 });
  await store.add({ ...item('mike'), queuedAt: 200 });

  const order: string[] = [];
  const q = new UploadQueue(
    store,
    { async run(it: QueueItem) { order.push(it.id); } },
    { baseMs: 1, maxMs: 4, maxAttempts: 3 }
  );
  await q.drain();

  expect(order).toEqual(['alpha', 'mike', 'zulu']);
});

test('a drain requested while one is running resolves only when the work is done', async () => {
  const store = new MemStore();
  let release: (() => void) | null = null;
  const started: string[] = [];
  const uploader = {
    async run(it: QueueItem) {
      started.push(it.id);
      if (it.id === 'slow') await new Promise<void>((r) => { release = r; });
    }
  };
  const q = new UploadQueue(store, uploader, { baseMs: 1, maxMs: 4, maxAttempts: 3 });
  await q.enqueue({ ...item('slow'), queuedAt: 1 });

  const first = q.drain();
  await new Promise((r) => setTimeout(r, 5)); // let the slow upload begin
  await q.enqueue({ ...item('second'), queuedAt: 2 });
  const second = q.drain(); // requested mid-flight

  release!();
  await Promise.all([first, second]);

  // If drain() had returned early, 'second' would still be sitting in the store.
  expect(started).toEqual(['slow', 'second']);
  expect(await store.all()).toEqual([]);
});

test('classifyStatus separates transient failures from permanent ones', () => {
  expect(classifyStatus(500, 'sign')).toBeInstanceOf(Error);
  expect(classifyStatus(500, 'sign')).not.toBeInstanceOf(NonRetryableError);
  expect(classifyStatus(429, 'sign')).not.toBeInstanceOf(NonRetryableError);
  expect(classifyStatus(401, 'sign')).toBeInstanceOf(NonRetryableError);
  expect(classifyStatus(403, 'sign')).toBeInstanceOf(NonRetryableError);
  expect(classifyStatus(400, 'meta')).toBeInstanceOf(NonRetryableError);
  expect(classifyStatus(200, 'sign')).toBeNull();
});

test('uploader turns a 409 from /sign into AlreadyUploaded and skips processing', async () => {
  let processed = false;
  const uploader = makeR2Uploader({
    workerUrl: 'https://wkr',
    auth: async () => ({ authorization: 'Bearer tok' }),
    process: async () => {
      processed = true;
      return { avif: new Blob(['a']), width: 1, height: 1, bytes: 1 };
    },
    fetchImpl: (async (url: string) => {
      if (String(url).endsWith('/sign')) {
        return new Response(JSON.stringify({ error: 'already_confirmed' }), { status: 409 });
      }
      return new Response('{}');
    }) as any
  });

  await expect(uploader.run(item('f'))).rejects.toBeInstanceOf(AlreadyUploadedError);
  expect(processed).toBe(false); // no pointless AVIF encode for a photo already stored
});

test('uploader turns a 401 from /sign into a non-retryable error', async () => {
  const uploader = makeR2Uploader({
    workerUrl: 'https://wkr',
    auth: async () => ({ authorization: 'Bearer tok' }),
    process: async () => ({ avif: new Blob(['a']), width: 1, height: 1, bytes: 1 }),
    fetchImpl: (async () => new Response('{"error":"unauthorized"}', { status: 401 })) as any
  });

  await expect(uploader.run(item('g'))).rejects.toBeInstanceOf(NonRetryableError);
});
