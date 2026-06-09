import { test, expect } from 'bun:test';
import { buildPlaylist } from '../src/lib/playlist';
import type { WallPhoto, Sponsor } from '../src/lib/types';

const opts = { photoDurationMs: 6000, sponsorEvery: 3, defaultSponsorMs: 4000 };

function photos(n: number): WallPhoto[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    public_url: `https://cdn/${i + 1}.avif`,
    created_at: `t${i + 1}`
  }));
}

const msg: Sponsor = { type: 'message', text: 'Drink Cola' };
const img: Sponsor = { type: 'image', imageUrl: 'https://cdn/ad.png', durationMs: 9000 };

test('empty photos + empty sponsors returns []', () => {
  expect(buildPlaylist([], [], opts)).toEqual([]);
});

test('photos only -> photo slides in input order with photoDurationMs', () => {
  const out = buildPlaylist(photos(2), [], opts);
  expect(out.map((s) => s.kind)).toEqual(['photo', 'photo']);
  expect(out.map((s) => s.src)).toEqual(['https://cdn/1.avif', 'https://cdn/2.avif']);
  expect(out.every((s) => s.durationMs === 6000)).toBe(true);
  expect(out.map((s) => s.key)).toEqual(['photo:p1', 'photo:p2']);
});

test('sponsors only -> each sponsor once, solo keys, duration fallback', () => {
  const out = buildPlaylist([], [msg, img], opts);
  expect(out.map((s) => s.kind)).toEqual(['message', 'image']);
  expect(out[0]).toMatchObject({ kind: 'message', text: 'Drink Cola', durationMs: 4000, key: 'sponsor:0:solo' });
  expect(out[1]).toMatchObject({ kind: 'image', src: 'https://cdn/ad.png', durationMs: 9000, key: 'sponsor:1:solo' });
});

test('inserts one sponsor after every sponsorEvery photos, not after a trailing partial group', () => {
  // 5 photos, every 3 -> sponsor only after photo 3.
  const out = buildPlaylist(photos(5), [msg], opts);
  expect(out.map((s) => s.kind)).toEqual(['photo', 'photo', 'photo', 'message', 'photo', 'photo']);
});

test('exact multiple still does not append a trailing sponsor', () => {
  // 3 photos, every 3 -> sponsor after photo 3 (no extra trailing checks beyond it).
  const out = buildPlaylist(photos(3), [msg], opts);
  expect(out.map((s) => s.kind)).toEqual(['photo', 'photo', 'photo', 'message']);
});

test('sponsor insertion cycles through sponsors across multiple insertion points', () => {
  // 9 photos, every 3 -> 3 insertion points; sponsors [msg,img] cycle: msg, img, msg.
  const out = buildPlaylist(photos(9), [msg, img], opts);
  const sponsorSlides = out.filter((s) => s.kind !== 'photo');
  expect(sponsorSlides.map((s) => s.kind)).toEqual(['message', 'image', 'message']);
});

test('interleaved sponsor keys are anchored to the preceding photo (stable + unique)', () => {
  const out = buildPlaylist(photos(6), [msg, img], opts);
  const sponsorKeys = out.filter((s) => s.kind !== 'photo').map((s) => s.key);
  expect(sponsorKeys).toEqual(['sponsor:0:after:p3', 'sponsor:1:after:p6']);
});

test('sponsorEvery <= 0 disables interleaving (photos only)', () => {
  const out = buildPlaylist(photos(4), [msg], { ...opts, sponsorEvery: 0 });
  expect(out.every((s) => s.kind === 'photo')).toBe(true);
  expect(out.length).toBe(4);
});

test('photos but empty sponsors -> never inserts a sponsor slide', () => {
  const out = buildPlaylist(photos(6), [], opts);
  expect(out.every((s) => s.kind === 'photo')).toBe(true);
});

test('all keys are unique', () => {
  const out = buildPlaylist(photos(9), [msg, img], opts);
  const keys = out.map((s) => s.key);
  expect(new Set(keys).size).toBe(keys.length);
});
