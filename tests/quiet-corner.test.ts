import { test, expect } from 'bun:test';
import { quietestCorner } from '../src/lib/quiet-corner';
import type { Pixels } from '../src/lib/types';

// Build a WxH RGBA image: noisy everywhere except one flat corner.
function makeImage(w: number, h: number, flat: 'tl' | 'tr' | 'bl' | 'br'): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // high-variance checkerboard noise
      const v = ((x * 37 + y * 53) % 2) * 255;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  // flatten the chosen corner quadrant to a constant gray
  const halfW = Math.floor(w / 2), halfH = Math.floor(h / 2);
  const xs = flat === 'tl' || flat === 'bl' ? 0 : halfW;
  const ys = flat === 'tl' || flat === 'tr' ? 0 : halfH;
  for (let y = ys; y < ys + halfH; y++) {
    for (let x = xs; x < xs + halfW; x++) {
      const i = (y * w + x) * 4;
      data[i] = 128; data[i + 1] = 128; data[i + 2] = 128; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

test('detects the flat corner as quietest', () => {
  for (const c of ['tl', 'tr', 'bl', 'br'] as const) {
    expect(quietestCorner(makeImage(40, 40, c))).toBe(c);
  }
});
