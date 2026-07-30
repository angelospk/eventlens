import { test, expect } from 'bun:test';
import { UploadQueue } from '../src/lib/upload-queue';
import { fingerprintOf } from '../src/lib/fingerprint';
import type { QueueItem } from '../src/lib/types';

class MemStore {
  items = new Map<string, QueueItem>();
  sent = new Set<string>();
  async add(it: QueueItem) { this.items.set(it.id, { ...it }); }
  async update(id: string, patch: Partial<QueueItem>) {
    const cur = this.items.get(id);
    if (cur) this.items.set(id, { ...cur, ...patch });
  }
  async remove(id: string) { this.items.delete(id); }
  async all() { return [...this.items.values()]; }
  async markSent(fp: string) { this.sent.add(fp); }
  async wasSent(fp: string) { return this.sent.has(fp); }
}

const photo = (id: string, fingerprint: string): QueueItem => ({
  id,
  file: new Blob(['x']),
  originalName: `${id}.jpg`,
  eventDate: '2026-07-30',
  status: 'pending',
  attempts: 0,
  fingerprint
});

const okUploader = { async run() {} };
const RETRY = { baseMs: 1, maxMs: 4, maxAttempts: 3 };

test('the same file picked twice in one go is only queued once', async () => {
  const store = new MemStore();
  const q = new UploadQueue(store, okUploader, RETRY);

  expect(await q.enqueue(photo('a', 'DSC_01.jpg|1200|999'))).toBe('queued');
  expect(await q.enqueue(photo('b', 'DSC_01.jpg|1200|999'))).toBe('duplicate');

  expect((await store.all()).length).toBe(1);
});

test('a file picked again after it was uploaded is not sent a second time', async () => {
  const store = new MemStore();
  const q = new UploadQueue(store, okUploader, RETRY);
  const fp = 'DSC_02.jpg|3400|555';

  await q.enqueue(photo('a', fp));
  await q.drain();
  expect(await store.all()).toEqual([]); // uploaded and cleared from the queue
  expect(store.sent.has(fp)).toBe(true); // but remembered

  expect(await q.enqueue(photo('b', fp))).toBe('duplicate');
  expect(await store.all()).toEqual([]);
});

test('different photographs are never mistaken for each other', async () => {
  const store = new MemStore();
  const q = new UploadQueue(store, okUploader, RETRY);

  expect(await q.enqueue(photo('a', 'DSC_01.jpg|1200|999'))).toBe('queued');
  expect(await q.enqueue(photo('b', 'DSC_02.jpg|1200|999'))).toBe('queued'); // same size and time
  expect(await q.enqueue(photo('c', 'DSC_01.jpg|1201|999'))).toBe('queued'); // one byte apart
  expect(await q.enqueue(photo('d', 'DSC_01.jpg|1200|1000'))).toBe('queued'); // edited later

  expect((await store.all()).length).toBe(4);
});

test('a photo that failed and was discarded can be chosen again', async () => {
  const store = new MemStore();
  const q = new UploadQueue(store, okUploader, RETRY);
  const fp = 'DSC_03.jpg|900|111';

  await q.enqueue(photo('a', fp));
  await q.discard('a'); // the photographer removed it by hand

  // Nothing was ever sent, so re-picking it must work.
  expect(await q.enqueue(photo('b', fp))).toBe('queued');
});

test('a store with no memory of sent files still blocks in-queue duplicates', async () => {
  // markSent/wasSent are optional on the interface; the queue must not assume them.
  const bare = {
    items: new Map<string, QueueItem>(),
    async add(it: QueueItem) { this.items.set(it.id, { ...it }); },
    async update() {},
    async remove(id: string) { this.items.delete(id); },
    async all() { return [...this.items.values()]; }
  };
  const q = new UploadQueue(bare, okUploader, RETRY);
  expect(await q.enqueue(photo('a', 'x|1|1'))).toBe('queued');
  expect(await q.enqueue(photo('b', 'x|1|1'))).toBe('duplicate');
});

test('items without a fingerprint are always accepted', async () => {
  const store = new MemStore();
  const q = new UploadQueue(store, okUploader, RETRY);
  const noFp = { ...photo('a', ''), fingerprint: undefined };
  expect(await q.enqueue(noFp)).toBe('queued');
  expect(await q.enqueue({ ...noFp, id: 'b' })).toBe('queued');
});

test('the fingerprint is the file identity, not its contents', () => {
  const f = new File(['abc'], 'DSC_1234.JPG', { lastModified: 1_700_000_000_000 });
  expect(fingerprintOf(f)).toBe('DSC_1234.JPG|3|1700000000000');

  // Same bytes, different file: two separate photographs as far as the picker is concerned.
  const other = new File(['abc'], 'copy.JPG', { lastModified: 1_700_000_000_000 });
  expect(fingerprintOf(other)).not.toBe(fingerprintOf(f));
});
