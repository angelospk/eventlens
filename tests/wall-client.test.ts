import { test, expect, mock } from 'bun:test';
import { fetchWallPhotos } from '../src/lib/wall-client';

test('GETs public /wall with date query (no passcode header), returns photos', async () => {
  let seenUrl = '';
  let seenHeaders: Record<string, string> | undefined;
  const fakeFetch = mock(async (url: string, opts: any) => {
    seenUrl = url;
    seenHeaders = opts?.headers;
    return new Response(JSON.stringify({ photos: [{ id: 'a', public_url: 'u', created_at: 't' }] }));
  });
  const photos = await fetchWallPhotos(
    { workerUrl: 'https://wkr', fetchImpl: fakeFetch as any },
    '2026-06-09'
  );
  expect(seenUrl).toBe('https://wkr/wall?date=2026-06-09');
  // public endpoint: must not send any passcode header
  expect(seenHeaders?.['x-passcode']).toBeUndefined();
  expect(seenHeaders?.['x-manager-passcode']).toBeUndefined();
  expect(photos).toEqual([{ id: 'a', public_url: 'u', created_at: 't' }]);
});

test('encodes the date param', async () => {
  let seenUrl = '';
  const fakeFetch = mock(async (url: string) => {
    seenUrl = url;
    return new Response(JSON.stringify({ photos: [] }));
  });
  await fetchWallPhotos({ workerUrl: 'https://wkr', fetchImpl: fakeFetch as any }, '2026/06/09');
  expect(seenUrl).toBe('https://wkr/wall?date=2026%2F06%2F09');
});

test('returns [] when body has no photos array', async () => {
  const fakeFetch = mock(async () => new Response(JSON.stringify({})));
  const photos = await fetchWallPhotos({ workerUrl: 'https://wkr', fetchImpl: fakeFetch as any }, '2026-06-09');
  expect(photos).toEqual([]);
});

test('throws on non-200', async () => {
  const fakeFetch = mock(async () => new Response('{"error":"bad input"}', { status: 400 }));
  await expect(
    fetchWallPhotos({ workerUrl: 'https://wkr', fetchImpl: fakeFetch as any }, 'bad')
  ).rejects.toThrow();
});
