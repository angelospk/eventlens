import { test, expect, mock } from 'bun:test';
import { moderatePhoto, moderateAll, deletePhoto, saveEvent } from '../src/lib/manager-client';
import { requestToken } from '../src/lib/auth-client';

// Every client now takes an auth-header supplier instead of a raw passcode, so the token
// can be refreshed between one request and the next.
const deps = (fetchImpl: any) => ({
  workerUrl: 'https://wkr',
  auth: async () => ({ authorization: 'Bearer tok-123' }),
  fetchImpl
});

test('approve posts the photo id and action, and returns the new state', async () => {
  let body: any = null;
  const f = mock(async (_url: string, opts: any) => {
    body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ ok: true, moderation: 'approved' }));
  });
  const res = await moderatePhoto(deps(f), 'photo-1234', 'approve');
  expect(body).toEqual({ id: 'photo-1234', action: 'approve' });
  expect(res).toBe('approved');
});

test('approve-all is scoped to one date and marked as a bulk action', async () => {
  let body: any = null;
  const f = mock(async (_url: string, opts: any) => {
    body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ ok: true, changed: 7 }));
  });
  const changed = await moderateAll(deps(f), '2026-07-29', 'approve');
  expect(body).toEqual({ date: '2026-07-29', action: 'approve', all: true });
  expect(changed).toBe(7);
});

test('a failed delete rejects so the UI can say the photo is still hidden', async () => {
  const f = mock(async () => new Response('{"error":"storage_delete_failed"}', { status: 502 }));
  await expect(deletePhoto(deps(f), 'photo-1234')).rejects.toThrow();
});

test('saving the night settings sends the auto-approve switch', async () => {
  let body: any = null;
  const f = mock(async (_url: string, opts: any) => {
    body = JSON.parse(opts.body);
    return new Response('{"ok":true}');
  });
  await saveEvent(deps(f), { date: '2026-07-29', title: 'Γάμος', autoApprove: true });
  expect(body).toEqual({ date: '2026-07-29', title: 'Γάμος', autoApprove: true });
});

test('a wrong passcode is reported as null rather than thrown', async () => {
  const f = mock(async () => new Response('{"error":"unauthorized"}', { status: 401 }));
  const grant = await requestToken({ workerUrl: 'https://wkr', fetchImpl: f as any }, 'bad', 'manager');
  expect(grant).toBeNull();
});

test('being throttled reads as a rejected passcode, not as a retryable error', async () => {
  const f = mock(async () => new Response('{"error":"too_many_attempts"}', { status: 429 }));
  const grant = await requestToken({ workerUrl: 'https://wkr', fetchImpl: f as any }, 'x', 'manager');
  expect(grant).toBeNull();
});

test('a server error throws, so the caller can tell it apart from a wrong passcode', async () => {
  const f = mock(async () => new Response('boom', { status: 503 }));
  await expect(
    requestToken({ workerUrl: 'https://wkr', fetchImpl: f as any }, 'x', 'manager')
  ).rejects.toThrow();
});

test('the manager passcode goes in the manager header, not the photographer one', async () => {
  let headers: any = null;
  const f = mock(async (_url: string, opts: any) => {
    headers = opts.headers;
    return new Response('{"role":"manager","token":"t","expiresAt":9999999999}');
  });
  await requestToken({ workerUrl: 'https://wkr', fetchImpl: f as any }, 'secret', 'manager');
  expect(headers['x-manager-passcode']).toBe('secret');
  expect(headers['x-passcode']).toBeUndefined();
});

test('the issued token is sent as a bearer header by the manager client', async () => {
  let headers: any = null;
  const f = mock(async (_url: string, opts: any) => {
    headers = opts.headers;
    return new Response(JSON.stringify({ ok: true, moderation: 'approved' }));
  });
  await moderatePhoto(deps(f), 'photo-1234', 'approve');
  expect(headers.authorization).toBe('Bearer tok-123');
  expect(headers['x-manager-passcode']).toBeUndefined();
});
