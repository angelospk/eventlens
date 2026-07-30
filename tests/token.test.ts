import { test, expect } from 'bun:test';
import { issueToken, verifyToken, secretEquals } from '../worker/src/token';

const NOW = 1_785_000_000;
const SECRET = 'a-long-random-token-secret-not-the-passcode';

test('a freshly issued token proves its role', async () => {
  const { token } = await issueToken('photographer', SECRET, NOW);
  expect(await verifyToken(token, SECRET, NOW)).toBe('photographer');
});

test('a token expires', async () => {
  const { token, expiresAt } = await issueToken('manager', SECRET, NOW);
  expect(await verifyToken(token, SECRET, expiresAt - 1)).toBe('manager');
  expect(await verifyToken(token, SECRET, expiresAt)).toBeNull();
  expect(await verifyToken(token, SECRET, expiresAt + 1)).toBeNull();
});

test('a photographer token cannot be re-labelled as a manager one', async () => {
  const { token } = await issueToken('photographer', SECRET, NOW);
  const forged = token.replace('photographer', 'manager');
  expect(await verifyToken(forged, SECRET, NOW)).toBeNull();
});

test('the two roles are signed with different derived keys', async () => {
  // Swap only the signature between a photographer and a manager token of the same age.
  const p = (await issueToken('photographer', SECRET, NOW)).token.split('.');
  const m = (await issueToken('manager', SECRET, NOW)).token.split('.');
  expect(p[3]).not.toBe(m[3]);
  expect(await verifyToken(['v1', 'manager', m[2], p[3]].join('.'), SECRET, NOW)).toBeNull();
});

test('the expiry cannot be extended without breaking the signature', async () => {
  const [v, role, exp, sig] = (await issueToken('manager', SECRET, NOW)).token.split('.');
  const forged = [v, role, String(Number(exp) + 86400), sig].join('.');
  expect(await verifyToken(forged, SECRET, NOW)).toBeNull();
});

test('rotating the token secret invalidates every token at once', async () => {
  const { token } = await issueToken('manager', SECRET, NOW);
  expect(await verifyToken(token, 'a-brand-new-secret', NOW)).toBeNull();
});

test('an empty secret never validates anything', async () => {
  const { token } = await issueToken('manager', SECRET, NOW);
  expect(await verifyToken(token, '', NOW)).toBeNull();
});

test('malformed tokens are rejected rather than throwing', async () => {
  for (const bad of ['', 'x', 'v1.manager', 'v2.manager.9999999999.aaaa', 'v1.manager.abc.aaaa',
                     'v1.manager.9999999999.!!!not-base64!!!', 'v1.admin.9999999999.aaaa']) {
    expect(await verifyToken(bad, SECRET, NOW)).toBeNull();
  }
});

test('an unset secret locks the door instead of opening it', async () => {
  // An unconfigured binding is `undefined`, and TextEncoder turns that into the empty
  // string. Without an explicit guard, a request sending an empty header would hash to the
  // same value and be accepted as valid.
  expect(await secretEquals('', undefined)).toBe(false);
  expect(await secretEquals('', '')).toBe(false);
  expect(await secretEquals(undefined, undefined)).toBe(false);
  expect(await secretEquals('anything', undefined)).toBe(false);
  expect(await secretEquals(undefined, 'anything')).toBe(false);
  expect(await secretEquals(null, null)).toBe(false);
});

test('secretEquals matches only identical secrets', async () => {
  expect(await secretEquals('hunter2', 'hunter2')).toBe(true);
  expect(await secretEquals('hunter2', 'hunter3')).toBe(false);
  expect(await secretEquals('hunter2', 'hunter2 ')).toBe(false);
  expect(await secretEquals('short', 'a-much-longer-secret')).toBe(false);
});

// --- object key namespacing -------------------------------------------------------
// The thumbnail key must never be constructible as a real photograph's key. Ids are
// client-chosen and `_` is legal in them, so `<id>_t.webp` was ambiguous: a photograph
// with id `abc_t` claimed the exact key used for the thumbnail of `abc`.
const EVENT_PREFIX = 'events/';
const thumbKeyFor = (key: string) =>
  key.startsWith(EVENT_PREFIX) ? 'thumbs/' + key.slice(EVENT_PREFIX.length) : '';

test('a thumbnail key can never collide with another photograph key', async () => {
  const photo = (id: string) => `events/2026-07-30/${id}.webp`;

  // The case that used to collide.
  expect(thumbKeyFor(photo('abcdefgh'))).not.toBe(photo('abcdefgh_t'));
  expect(thumbKeyFor(photo('abcdefgh'))).toBe('thumbs/2026-07-30/abcdefgh.webp');

  // Thumbnails and photographs live in prefixes that cannot overlap at all.
  for (const id of ['abcdefgh', 'abcdefgh_t', 'a_t_b_t_c', 'with-hyphens-1']) {
    expect(thumbKeyFor(photo(id)).startsWith('thumbs/')).toBe(true);
    expect(photo(id).startsWith('events/')).toBe(true);
  }

  // Two different photographs never share a thumbnail.
  const keys = ['abcdefgh', 'abcdefgh_t', 'zzzzzzzz'].map((id) => thumbKeyFor(photo(id)));
  expect(new Set(keys).size).toBe(keys.length);
});
