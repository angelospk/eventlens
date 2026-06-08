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
