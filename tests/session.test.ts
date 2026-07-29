import { test, expect, beforeEach } from 'bun:test';
import { Session } from '../src/lib/session';

// The Session talks to storage and to $app/environment. bun:test runs outside a browser,
// so `browser` is false there and the storage paths are skipped; what is exercised here is
// the credential logic, which is where the security-relevant behaviour lives.

const WORKER = 'https://wkr';

function grantResponse(token = 'tok-1', ttl = 3600) {
  return new Response(
    JSON.stringify({ role: 'photographer', token, expiresAt: Math.floor(Date.now() / 1000) + ttl })
  );
}

let calls = 0;
beforeEach(() => {
  calls = 0;
});

test('a successful sign-in sends the token, never the passcode', async () => {
  const s = new Session(WORKER, 'photographer', async () => {
    calls++;
    return grantResponse();
  });
  expect(await s.signIn('right')).toBe('ok');
  const h = await s.headers();
  expect(h.authorization).toBe('Bearer tok-1');
  expect(h['x-passcode']).toBeUndefined();
  expect(s.verified).toBe(true);
});

test('a rejected passcode leaves the session unauthenticated', async () => {
  const s = new Session(WORKER, 'manager', async () => new Response('{}', { status: 401 }));
  expect(await s.signIn('wrong')).toBe('bad');
  expect(s.authenticated).toBe(false);
  expect(await s.headers()).toEqual({});
});

test('signing in with no network keeps the passcode in memory and reports it', async () => {
  const s = new Session(WORKER, 'photographer', async () => {
    throw new Error('offline');
  });
  expect(await s.signIn('right')).toBe('offline');
  expect(s.authenticated).toBe(true);
  expect(s.verified).toBe(false); // nothing has confirmed the passcode yet
  // Until a token can be minted, requests fall back to the passcode header.
  expect(await s.headers()).toEqual({ 'x-passcode': 'right' });
});

test('an offline sign-in upgrades itself to a token once the network returns', async () => {
  let online = false;
  const s = new Session(WORKER, 'photographer', async () => {
    if (!online) throw new Error('offline');
    return grantResponse('tok-late');
  });
  await s.signIn('right');
  online = true;
  expect((await s.headers()).authorization).toBe('Bearer tok-late');
  expect(s.verified).toBe(true);
});

test('a draining queue mints one token, not one per photo', async () => {
  const s = new Session(WORKER, 'photographer', async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return grantResponse();
  });
  await s.signIn('right').catch(() => {});
  calls = 0;
  // Force the token to look stale so every caller wants a refresh at once.
  (s as unknown as { expiresAt: number }).expiresAt = 0;
  await Promise.all(Array.from({ length: 8 }, () => s.headers()));
  expect(calls).toBe(1);
});

test('signing out mid-request does not let the finished request sign you back in', async () => {
  let release: (() => void) | null = null;
  const s = new Session(WORKER, 'photographer', async () => {
    await new Promise<void>((r) => { release = r; });
    return grantResponse('tok-race');
  });

  const pending = s.signIn('right');
  await new Promise((r) => setTimeout(r, 5));
  s.signOut();
  release!();

  expect(await pending).toBe('bad');
  expect(s.authenticated).toBe(false);
  expect(s.verified).toBe(false);
  expect(await s.headers()).toEqual({});
});

test('signing out clears the credentials it was holding', async () => {
  const s = new Session(WORKER, 'photographer', async () => grantResponse());
  await s.signIn('right');
  expect(s.authenticated).toBe(true);
  s.signOut();
  expect(s.authenticated).toBe(false);
  expect(await s.headers()).toEqual({});
});
