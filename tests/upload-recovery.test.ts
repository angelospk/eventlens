import { test, expect } from 'bun:test';
import { UploadQueue } from '../src/lib/upload-queue';
import { AlreadyUploadedError, NetworkError, NonRetryableError, classifyStatus, describeError } from '../src/lib/errors';
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
      return { blob: new Blob(['a']), mime: 'image/webp', ext: 'webp', width: 1, height: 1, bytes: 1 };
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
    process: async () => ({ blob: new Blob(['a']), mime: 'image/webp', ext: 'webp', width: 1, height: 1, bytes: 1 }),
    fetchImpl: (async () => new Response('{"error":"unauthorized"}', { status: 401 })) as any
  });

  await expect(uploader.run(item('g'))).rejects.toBeInstanceOf(NonRetryableError);
});

/** A dead network now retries forever, so tests watch the store instead of awaiting drain. */
async function until(check: () => Promise<boolean>, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

test('the photographer is told a network failure in plain language, not a stack trace', async () => {
  const store = new MemStore();
  const uploader = { async run() { throw new NetworkError('/sign'); } };
  const q = new UploadQueue(store, uploader, { baseMs: 1, maxMs: 2, maxAttempts: 2 });
  await q.enqueue(item('n1'));
  void q.drain();
  await until(async () => Boolean((await store.all())[0]?.lastError));
  q.stop();

  const [stored] = await store.all();
  expect(stored.lastError).toBe('Δεν έφυγε, δεν υπάρχει σύνδεση. Θα ξαναδοκιμάσει μόνο του.');
  expect(stored.lastError).not.toContain('fetch');
});

test('a dead network never marks a photo as failed, however long it lasts', async () => {
  const store = new MemStore();
  const q = new UploadQueue(
    store,
    { async run() { throw new NetworkError('/sign'); } },
    { baseMs: 1, maxMs: 2, maxAttempts: 3 }
  );
  await q.enqueue(item('n5'));
  void q.drain();
  // Far more attempts than maxAttempts: the photo must still be waiting, not given up on.
  await until(async () => ((await store.all())[0]?.tries ?? 0) > 8);
  q.stop();

  const [stored] = await store.all();
  expect(stored.tries).toBeGreaterThan(8);
  expect(stored.attempts).toBe(0); // no network failure counted against the limit
  expect(stored.status).not.toBe('error');
});

test('resume cuts short the backoff instead of waiting it out', async () => {
  const store = new MemStore();
  let fail = true;
  const q = new UploadQueue(
    store,
    { async run() { if (fail) throw new NetworkError('/sign'); } },
    { baseMs: 60_000, maxMs: 60_000, maxAttempts: 5 } // a minute of backoff after one failure
  );
  await q.enqueue(item('n6'));
  void q.drain();
  await until(async () => Boolean((await store.all())[0]?.nextAttemptAt));

  fail = false;
  const t0 = Date.now();
  await q.resume();

  expect(await store.all()).toEqual([]); // uploaded
  expect(Date.now() - t0).toBeLessThan(2000); // not the 60s the backoff asked for
});

test('repeated network failures raise the "weak signal" flag, other failures do not', async () => {
  const store = new MemStore();
  const q = new UploadQueue(
    store,
    { async run() { throw new NetworkError('/sign'); } },
    { baseMs: 1, maxMs: 2, maxAttempts: 4 }
  );
  await q.enqueue(item('n2'));
  void q.drain();
  await until(async () => q.struggling);
  q.stop();
  expect(q.struggling).toBe(true);

  const store2 = new MemStore();
  const q2 = new UploadQueue(
    store2,
    { async run() { throw new NonRetryableError('nope', 'bad_request'); } },
    { baseMs: 1, maxMs: 2, maxAttempts: 4 }
  );
  await q2.enqueue(item('n3'));
  await q2.drain();
  expect(q2.struggling).toBe(false); // a rejected file is not a connection problem
});

test('a success clears the weak-signal flag', async () => {
  const store = new MemStore();
  let fail = true;
  const q = new UploadQueue(
    store,
    { async run() { if (fail) throw new NetworkError('/sign'); } },
    { baseMs: 1, maxMs: 2, maxAttempts: 9 }
  );
  await q.enqueue(item('n4'));
  void q.drain();
  await until(async () => q.struggling);
  q.stop();
  expect(q.struggling).toBe(true);

  fail = false;
  await q.retryAll();
  expect(q.struggling).toBe(false);
});

test('the in-memory fallback behaves like a real queue', async () => {
  // What matters is not how the fallback is chosen but that photographs still upload
  // through it: on a device where the database will not open, this is the whole queue.
  const { MemoryStore } = await import('../src/lib/idb-store');
  const store = new MemoryStore();

  const uploaded: string[] = [];
  const q = new UploadQueue(
    store,
    { async run(it: QueueItem) { uploaded.push(it.id); } },
    { baseMs: 1, maxMs: 4, maxAttempts: 3 }
  );
  await q.enqueue({ ...item('mem1'), queuedAt: 1 });
  await q.enqueue({ ...item('mem2'), queuedAt: 2 });
  await q.drain();

  expect(uploaded).toEqual(['mem1', 'mem2']);
  expect(await store.all()).toEqual([]);
  expect(q.completed).toBe(2);

  // The duplicate guard has to keep working, or a retried night re-uploads everything.
  await store.markSent('fp-1');
  expect(await store.wasSent('fp-1')).toBe(true);
  expect(await store.wasSent('fp-2')).toBe(false);
});

test('createQueueStorage always returns a usable queue', async () => {
  const { createQueueStorage } = await import('../src/lib/idb-store');
  const storage = await createQueueStorage('eventlens-test-queue');
  // Whichever path it took, the caller must be able to queue a photograph.
  await storage.store.add(item('probe'));
  expect((await storage.store.all()).map((i) => i.id)).toContain('probe');
  await storage.store.remove('probe');
});

test('a struggling photograph drifts behind the ones that have not failed', async () => {
  const store = new MemStore();
  // 'sticky' was shot first but has already failed twice; the other two are fresh.
  await store.add({ ...item('sticky'), queuedAt: 1, tries: 2 });
  await store.add({ ...item('fresh-a'), queuedAt: 2 });
  await store.add({ ...item('fresh-b'), queuedAt: 3 });

  const order: string[] = [];
  const q = new UploadQueue(
    store,
    { async run(it: QueueItem) { order.push(it.id); } },
    { baseMs: 1, maxMs: 4, maxAttempts: 8 }
  );
  await q.drain();

  // Oldest-first alone would have put 'sticky' first and made every later photo wait.
  expect(order).toEqual(['fresh-a', 'fresh-b', 'sticky']);
  expect(q.completed).toBe(3); // and it still gets its turn
});

test('a failed thumbnail does not fail the photograph', async () => {
  // The full frame is already stored by this point. Losing the small copy costs a visitor
  // some bytes; losing the photograph costs the photographer the shot.
  let metaBody: any = null;
  const uploader = makeR2Uploader({
    workerUrl: 'https://wkr',
    auth: async () => ({ authorization: 'Bearer tok' }),
    process: async () => ({
      blob: new Blob(['full']),
      thumb: new Blob(['small']),
      mime: 'image/webp',
      width: 10,
      height: 10,
      bytes: 4
    }),
    fetchImpl: (async (url: string, opts: any) => {
      const u = String(url);
      if (u.endsWith('/sign')) {
        return new Response(JSON.stringify({
          uploadUrl: 'https://r2/full',
          thumbUploadUrl: 'https://r2/thumb',
          publicUrl: 'https://pub/x',
          key: 'k'
        }));
      }
      if (u === 'https://r2/thumb') throw new Error('thumbnail upload died');
      if (u === 'https://r2/full') return new Response(null, { status: 200 });
      if (u.endsWith('/meta')) {
        metaBody = JSON.parse(opts.body);
        return new Response('{"ok":true}');
      }
      return new Response('{}');
    }) as any
  });

  await uploader.run(item('withthumb')); // must not throw
  expect(metaBody.hasThumb).toBe(false); // and the server is told the truth
});

test('a successful thumbnail is reported so the gallery can use it', async () => {
  let metaBody: any = null;
  const seen: string[] = [];
  const uploader = makeR2Uploader({
    workerUrl: 'https://wkr',
    auth: async () => ({ authorization: 'Bearer tok' }),
    process: async () => ({
      blob: new Blob(['full']),
      thumb: new Blob(['small']),
      mime: 'image/webp',
      width: 10, height: 10, bytes: 4
    }),
    fetchImpl: (async (url: string, opts: any) => {
      const u = String(url);
      seen.push(u);
      if (u.endsWith('/sign')) {
        return new Response(JSON.stringify({
          uploadUrl: 'https://r2/full',
          thumbUploadUrl: 'https://r2/thumb',
          publicUrl: 'https://pub/x', key: 'k'
        }));
      }
      if (u.endsWith('/meta')) { metaBody = JSON.parse(opts.body); return new Response('{"ok":true}'); }
      return new Response(null, { status: 200 });
    }) as any
  });

  await uploader.run(item('good'));
  expect(seen).toContain('https://r2/full');
  expect(seen).toContain('https://r2/thumb');
  expect(metaBody.hasThumb).toBe(true);
});

test('a request that never answers is abandoned instead of hanging the queue', async () => {
  // The reported failure: a photograph sits on "uploading" and nothing else moves. Without
  // a deadline the fetch simply never settles, so the drain waits behind it forever.
  const store = new MemStore();
  let aborted = false;
  const uploader = {
    async run(_it: QueueItem, signal?: AbortSignal) {
      await new Promise((_res, rej) => {
        signal?.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); });
      });
    }
  };
  const q = new UploadQueue(store, uploader, { baseMs: 1, maxMs: 4, maxAttempts: 2 });
  await q.enqueue(item('hangs'));

  const draining = q.drain();
  await new Promise((r) => setTimeout(r, 20));

  // The photographer gives up on it; the queue must come back to life.
  await q.cancel('hangs');
  await draining;

  expect(aborted).toBe(true);
  expect(await store.all()).toEqual([]);
});

test('cancelling one wedged photograph lets the rest of the queue through', async () => {
  const store = new MemStore();
  const uploaded: string[] = [];
  const uploader = {
    async run(it: QueueItem, signal?: AbortSignal) {
      if (it.id === 'wedged') {
        await new Promise((_res, rej) =>
          signal?.addEventListener('abort', () => rej(new Error('aborted')))
        );
        return;
      }
      uploaded.push(it.id);
    }
  };
  const q = new UploadQueue(store, uploader, { baseMs: 1, maxMs: 4, maxAttempts: 2 });
  await q.enqueue({ ...item('wedged'), queuedAt: 1 });
  await q.enqueue({ ...item('healthy'), queuedAt: 2 });

  const draining = q.drain();
  await new Promise((r) => setTimeout(r, 20));
  await q.cancel('wedged');
  await draining;

  expect(uploaded).toEqual(['healthy']);
  expect(await store.all()).toEqual([]);
});

test('an upload records what went up last, for "where did I get to"', async () => {
  const store = new MemStore();
  const q = new UploadQueue(store, { async run() {} }, { baseMs: 1, maxMs: 4, maxAttempts: 2 });
  await q.enqueue({ ...item('first'), queuedAt: 1 });
  await q.enqueue({ ...item('second'), queuedAt: 2 });
  await q.drain();

  expect(q.lastDone?.name).toBe('second.jpg');
  expect(q.lastDone?.at).toBeGreaterThan(0);
});

test('rows left mid-flight by a kill are put back in line, not shown as uploading', async () => {
  // What the photographer saw: three photographs all claiming to upload at once, when the
  // queue only ever works on one. They were interrupted, not running.
  const store = new MemStore();
  await store.add({ ...item('killed1'), status: 'uploading', startedAt: 1 });
  await store.add({ ...item('killed2'), status: 'uploading', startedAt: 2 });

  const uploaded: string[] = [];
  const q = new UploadQueue(
    store,
    { async run(it: QueueItem) { uploaded.push(it.id); } },
    { baseMs: 1, maxMs: 4, maxAttempts: 3 }
  );
  await q.drain();

  expect(uploaded.sort()).toEqual(['killed1', 'killed2']);
  expect(await store.all()).toEqual([]);
});

/** A lock manager that hands the lock over only once the holder releases it. */
function serialLocks() {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    locks: {
      // Same shape as the real one: (name, options, callback).
      request: (_n: string, opts: any, cb?: () => Promise<unknown>) => {
        const run = (typeof opts === 'function' ? opts : cb) as () => Promise<unknown>;
        const next = chain.then(run);
        chain = next.catch(() => {});
        return next;
      }
    }
  };
}

async function withGlobals(patch: { navigator?: any }, fn: () => Promise<void>) {
  const g = globalThis as any;
  const saved = { navigator: g.navigator };
  Object.assign(g, patch);
  try {
    await fn();
  } finally {
    Object.assign(g, saved);
  }
}

test('two queues on one database upload each photograph once, not twice', async () => {
  // The failure this lock exists for: two windows of the app draining the same rows, each
  // resetting what the other was mid-way through, so nothing ever finished while six
  // photographs all claimed to be uploading.
  const store = new MemStore();
  const uploaded: string[] = [];
  const uploader = {
    async run(it: QueueItem) {
      await new Promise((r) => setTimeout(r, 20)); // long enough for the other to interfere
      uploaded.push(it.id);
    }
  };
  const a = new UploadQueue(store, uploader, { baseMs: 1, maxMs: 4, maxAttempts: 3 });
  const b = new UploadQueue(store, uploader, { baseMs: 1, maxMs: 4, maxAttempts: 3 });
  for (const id of ['p1', 'p2', 'p3']) await store.add(item(id));

  await withGlobals({ navigator: serialLocks() }, async () => {
    await Promise.all([a.drain(), b.drain()]);
  });

  expect(uploaded.sort()).toEqual(['p1', 'p2', 'p3']); // each exactly once
  expect(await store.all()).toEqual([]);
}, 20000);

test('a queue waiting out a backoff does not hold the lock', async () => {
  // Holding the lock across the wait would mean one window's failed photograph blocking
  // every other window from uploading anything at all.
  const store = new MemStore();
  const uploaded: string[] = [];
  // 'slow' fails once and then sits in a long backoff; 'quick' belongs to the other queue.
  let failed = false;
  const a = new UploadQueue(
    store,
    { async run() { if (!failed) { failed = true; throw new NetworkError('/sign'); } await new Promise(() => {}); } },
    { baseMs: 60_000, maxMs: 60_000, maxAttempts: 5 }
  );
  const b = new UploadQueue(
    store,
    { async run(it: QueueItem) { uploaded.push(it.id); } },
    { baseMs: 1, maxMs: 4, maxAttempts: 5 }
  );
  await store.add({ ...item('slow'), queuedAt: 1 });

  await withGlobals({ navigator: serialLocks() }, async () => {
    void a.drain();
    await new Promise((r) => setTimeout(r, 50)); // let 'slow' fail and start its backoff
    await store.add({ ...item('quick'), queuedAt: 2 });
    void b.drain();
    // If the lock were held across the backoff this would still be empty when time is up.
    for (let i = 0; i < 100 && !uploaded.length; i++) await new Promise((r) => setTimeout(r, 10));
    a.stop();
    b.stop();
  });

  expect(uploaded).toEqual(['quick']); // got the lock while the other was asleep
});

test('a retry asked for while the queue is winding down still runs', async () => {
  // The subtle half of the vanishing-photos bug: `drain` deferring to a loop that has
  // already decided to exit means nobody does the work, and the queue sits there idle
  // with items in it. The photographer presses the button and nothing happens at all.
  const store = new MemStore();
  let fail = true;
  const q = new UploadQueue(
    store,
    { async run() { if (fail) throw new NonRetryableError('bad file', 'bad_request'); } },
    { baseMs: 1, maxMs: 2, maxAttempts: 3 }
  );
  await q.enqueue(item('w'));
  await q.drain();
  expect(store.items.get('w')?.status).toBe('error');

  q.stop(); // e.g. the photographer signed out and back in
  fail = false;
  await q.retryAll();
  expect(q.completed).toBe(1);
  expect(store.items.size).toBe(0);
});

test('a storage failure that aborts is not mistaken for the queue being stopped', async () => {
  // `locks.request` adopts whatever the callback returns, so an AbortError thrown by
  // IndexedDB inside the work arrives at the same catch as an aborted *wait* for the lock.
  // Treating it as a stop ended the pass with every photograph still pending and nothing
  // anywhere saying why — the exact silence that took a night to diagnose.
  const store = new MemStore();
  const aborted = new Error('the transaction was aborted');
  aborted.name = 'AbortError';
  const failing = {
    ...store,
    add: (it: QueueItem) => store.add(it),
    update: (id: string, p: Partial<QueueItem>) => store.update(id, p),
    remove: (id: string) => store.remove(id),
    async all(): Promise<QueueItem[]> {
      throw aborted;
    }
  };
  const queue = new UploadQueue(
    failing,
    { async run() {} },
    { baseMs: 1, maxMs: 4, maxAttempts: 3 }
  );

  await withGlobals({ navigator: serialLocks() }, async () => {
    // It has to come out as a failure. Swallowed, the caller cannot tell this apart from
    // an orderly stop with nothing left to do.
    expect(queue.drain()).rejects.toThrow('the transaction was aborted');
  });
});
