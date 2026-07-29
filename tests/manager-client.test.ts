import { test, expect, mock } from 'bun:test';
import { fetchList } from '../src/lib/manager-client';

test('GETs /list with the date query and the auth header, returns photos', async () => {
  let seenUrl = '';
  let seenHeader: string | null | undefined;
  const fakeFetch = mock(async (url: string, opts: any) => {
    seenUrl = url;
    seenHeader = opts?.headers?.authorization ?? null;
    return new Response(
      JSON.stringify({
        photos: [
          {
            id: 'a', public_url: 'u', original_name: 'p.jpg',
            width: 1, height: 2, bytes: 3, created_at: 't', moderation: 'pending'
          }
        ],
        event: { date: '2026-06-08', title: 'Γάμος', autoApprove: false }
      })
    );
  });
  const { photos, event } = await fetchList(
    {
      workerUrl: 'https://wkr',
      auth: async () => ({ authorization: 'Bearer m-token' }),
      fetchImpl: fakeFetch as any
    },
    '2026-06-08'
  );
  expect(seenUrl).toBe('https://wkr/list?date=2026-06-08');
  expect(seenHeader).toBe('Bearer m-token');
  expect(photos.length).toBe(1);
  expect(photos[0].id).toBe('a');
  expect(photos[0].moderation).toBe('pending');
  expect(event.autoApprove).toBe(false);
});

test('throws on non-200', async () => {
  const fakeFetch = mock(async () => new Response('{"error":"unauthorized"}', { status: 401 }));
  await expect(
    fetchList(
      { workerUrl: 'https://wkr', auth: async () => ({}), fetchImpl: fakeFetch as any },
      '2026-06-08'
    )
  ).rejects.toThrow();
});
