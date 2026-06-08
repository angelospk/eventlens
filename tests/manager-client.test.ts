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
