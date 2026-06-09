import type { WallPhoto, Sponsor, Slide } from './types';

export interface PlaylistOpts {
  photoDurationMs: number;
  sponsorEvery: number;     // insert a sponsor after every N photos; <= 0 disables interleaving
  defaultSponsorMs: number; // used when a sponsor has no durationMs
}

function sponsorSlide(s: Sponsor, defaultMs: number, key: string): Slide {
  return {
    kind: s.type,
    src: s.type === 'image' ? s.imageUrl : undefined,
    text: s.type === 'message' ? s.text : undefined,
    durationMs: s.durationMs ?? defaultMs,
    key
  };
}

// Pure: turns confirmed photos + sponsors into the ordered slide list the wall plays.
//
// - one photo slide per photo, in order
// - after every `sponsorEvery` complete photos, one sponsor slide (sponsors cycle round-robin);
//   no sponsor is appended after a trailing partial group
// - no photos but sponsors -> each sponsor once (the player loops the whole list)
// - no photos and no sponsors -> []
//
// Keys are stable across rebuilds: interleaved sponsors are anchored to the preceding photo id
// (`sponsor:<sponsorIndex>:after:<photoId>`) so the same placement keeps the same key even as
// new photos arrive; sponsor-only slides use `sponsor:<index>:solo`.
export function buildPlaylist(photos: WallPhoto[], sponsors: Sponsor[], opts: PlaylistOpts): Slide[] {
  if (photos.length === 0) {
    return sponsors.map((s, i) => sponsorSlide(s, opts.defaultSponsorMs, `sponsor:${i}:solo`));
  }

  const slides: Slide[] = [];
  const interleave = opts.sponsorEvery > 0 && sponsors.length > 0;
  let cycle = 0; // index into sponsors for round-robin insertion

  photos.forEach((photo, i) => {
    slides.push({ kind: 'photo', src: photo.public_url, durationMs: opts.photoDurationMs, key: `photo:${photo.id}` });
    if (interleave && (i + 1) % opts.sponsorEvery === 0) {
      const idx = cycle % sponsors.length;
      slides.push(sponsorSlide(sponsors[idx], opts.defaultSponsorMs, `sponsor:${idx}:after:${photo.id}`));
      cycle++;
    }
  });

  return slides;
}
