import type { Corner, Pixels } from './types';

function luminance(data: Uint8ClampedArray, i: number): number {
  return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
}

// Variance of luminance over a rectangular region = "busyness".
function regionVariance(px: Pixels, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0, sumSq = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const l = luminance(px.data, (y * px.width + x) * 4);
      sum += l; sumSq += l * l; n++;
    }
  }
  if (n === 0) return Infinity;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function quietestCorner(px: Pixels, sampleFraction = 0.35): Corner {
  const sw = Math.max(1, Math.floor(px.width * sampleFraction));
  const sh = Math.max(1, Math.floor(px.height * sampleFraction));
  const regions: Record<Corner, [number, number, number, number]> = {
    tl: [0, 0, sw, sh],
    tr: [px.width - sw, 0, px.width, sh],
    bl: [0, px.height - sh, sw, px.height],
    br: [px.width - sw, px.height - sh, px.width, px.height]
  };
  let best: Corner = 'br';
  let bestVar = Infinity;
  for (const c of ['tl', 'tr', 'bl', 'br'] as Corner[]) {
    const v = regionVariance(px, ...regions[c]);
    if (v < bestVar) { bestVar = v; best = c; }
  }
  return best;
}
