import { test, expect, mock } from 'bun:test';
import { makeR2Uploader } from '../src/lib/r2-client';
import type { QueueItem } from '../src/lib/types';

const it: QueueItem = {
  id: 'abc12345', file: new Blob(['x']), originalName: 'p.jpg', eventDate: '2026-06-08',
  status: 'pending', attempts: 0
};

test('signs first, PUTs blob, then POSTs /meta in order', async () => {
  const calls: string[] = [];
  const fakeFetch = mock(async (url: string, opts: any) => {
    calls.push(`${opts?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/sign')) {
      return new Response(JSON.stringify({ uploadUrl: 'https://r2/put-here', publicUrl: 'https://cdn/abc.avif', key: 'events/2026-06-08/abc12345.avif' }));
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
