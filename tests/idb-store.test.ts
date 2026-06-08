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
