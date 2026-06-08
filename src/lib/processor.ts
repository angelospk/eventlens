import { encode as encodeAvif } from '@jsquash/avif';
import { base } from '$app/paths';
import { quietestCorner } from './quiet-corner';
import { config } from './config';
import type { Pixels, Processed } from './types';

async function loadLogo(): Promise<ImageBitmap> {
  const url = `${base}/${config.logoFile}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load logo ${url}: ${res.status}`);
  return createImageBitmap(await res.blob());
}

function cornerXY(corner: string, W: number, H: number, lw: number, lh: number, pad: number) {
  const x = corner === 'tl' || corner === 'bl' ? pad : W - lw - pad;
  const y = corner === 'tl' || corner === 'tr' ? pad : H - lh - pad;
  return { x, y };
}

export async function processImage(file: Blob): Promise<Processed> {
  const src = await createImageBitmap(file);
  let W = src.width, H = src.height;

  // optional downscale cap
  const cap = config.maxLongEdge;
  if (cap > 0 && Math.max(W, H) > cap) {
    const s = cap / Math.max(W, H);
    W = Math.round(W * s); H = Math.round(H * s);
  }

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d')!;
  ctx.filter = config.filter;                 // brand color grade
  ctx.drawImage(src, 0, 0, W, H);
  ctx.filter = 'none';

  // pick quiet corner from current pixels
  const id = ctx.getImageData(0, 0, W, H);
  const px: Pixels = { data: id.data, width: W, height: H };
  const corner = quietestCorner(px);

  // draw logo
  const logo = await loadLogo();
  const shortEdge = Math.min(W, H);
  const lw = Math.round(shortEdge * config.logoWidthFraction);
  const lh = Math.round((logo.height / logo.width) * lw);
  const pad = Math.round(shortEdge * config.logoPaddingFraction);
  const { x, y } = cornerXY(corner, W, H, lw, lh, pad);
  ctx.drawImage(logo, x, y, lw, lh);

  // encode AVIF — @jsquash/avif uses `speed` not `effort`; map config.avif.effort → speed
  const finalId = ctx.getImageData(0, 0, W, H);
  const buf = await encodeAvif(finalId, { quality: config.avif.quality, speed: config.avif.effort });
  const avif = new Blob([buf], { type: 'image/avif' });
  return { avif, width: W, height: H, bytes: avif.size };
}
