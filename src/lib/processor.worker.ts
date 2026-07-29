/// <reference lib="webworker" />
import { encode as encodeAvif } from '@jsquash/avif';
import { quietestCorner } from './quiet-corner';
import type { Corner, Pixels } from './types';

// Runs off the main thread: a 12MP photo would otherwise freeze the UI for seconds while
// the AVIF encoder works. One long-lived worker handles every photo, so the AVIF WASM
// module is initialised once instead of per upload.

export interface ProcessRequest {
  id: string;
  buffer: ArrayBuffer;
  type: string;
  logoUrl: string;
  maxLongEdge: number;
  quality: number;
  speed: number;
  logoWidthFraction: number;
  logoPaddingFraction: number;
  grade: { contrast: number; saturate: number; brightness: number };
}

export type ProcessResponse =
  | { id: string; ok: true; buffer: ArrayBuffer; width: number; height: number }
  | { id: string; ok: false; error: string };

let logoPromise: Promise<ImageBitmap> | null = null;

/** The logo never changes within a session, so decode it once and reuse the bitmap. */
function loadLogo(url: string): Promise<ImageBitmap> {
  if (!logoPromise) {
    // A captive-portal hotspot can leave this fetch hanging indefinitely, and every photo
    // waits behind it. Ten seconds, then fail and let the next photo retry.
    logoPromise = fetch(url, { signal: AbortSignal.timeout(10_000) })
      .then((res) => {
        if (!res.ok) throw new Error(`logo ${res.status}`);
        return res.blob();
      })
      .then(createImageBitmap)
      .catch((e) => {
        logoPromise = null; // let a later photo try again
        throw e;
      });
  }
  return logoPromise;
}

/**
 * Applies the brand grade pixel by pixel instead of via `ctx.filter`, which Safari does
 * not support — there the grade would silently vanish and iPhone uploads would look
 * different from everyone else's.
 */
function grade(data: Uint8ClampedArray, g: ProcessRequest['grade']) {
  // Luma coefficients (Rec. 601), the same basis the CSS saturate() filter uses.
  const LR = 0.213,
    LG = 0.715,
    LB = 0.072;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i],
      gr = data[i + 1],
      b = data[i + 2];

    r *= g.brightness;
    gr *= g.brightness;
    b *= g.brightness;

    r = (r - 128) * g.contrast + 128;
    gr = (gr - 128) * g.contrast + 128;
    b = (b - 128) * g.contrast + 128;

    const lum = LR * r + LG * gr + LB * b;
    r = lum + (r - lum) * g.saturate;
    gr = lum + (gr - lum) * g.saturate;
    b = lum + (b - lum) * g.saturate;

    data[i] = r;
    data[i + 1] = gr;
    data[i + 2] = b;
  }
}

function cornerXY(corner: Corner, W: number, H: number, lw: number, lh: number, pad: number) {
  const x = corner === 'tl' || corner === 'bl' ? pad : W - lw - pad;
  const y = corner === 'tl' || corner === 'tr' ? pad : H - lh - pad;
  return { x, y };
}

async function process(req: ProcessRequest): Promise<ProcessResponse> {
  let src: ImageBitmap | null = null;
  try {
    src = await createImageBitmap(new Blob([req.buffer], { type: req.type }));

    // Cap the long edge before allocating any canvas. A full-resolution phone photo would
    // otherwise mean hundreds of megabytes of RGBA and a dead tab on iOS.
    let W = src.width;
    let H = src.height;
    const cap = req.maxLongEdge;
    if (cap > 0 && Math.max(W, H) > cap) {
      const s = cap / Math.max(W, H);
      W = Math.max(1, Math.round(W * s));
      H = Math.max(1, Math.round(H * s));
    }

    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(src, 0, 0, W, H);
    src.close();
    src = null;

    // Grade, pick the calmest corner from the graded pixels, then write them back — one
    // read/write pair instead of a separate pass per step.
    const id = ctx.getImageData(0, 0, W, H);
    grade(id.data, req.grade);
    const px: Pixels = { data: id.data, width: W, height: H };
    const corner = quietestCorner(px);
    ctx.putImageData(id, 0, 0);

    const logo = await loadLogo(req.logoUrl);
    const shortEdge = Math.min(W, H);
    const lw = Math.round(shortEdge * req.logoWidthFraction);
    const lh = Math.round((logo.height / logo.width) * lw);
    const pad = Math.round(shortEdge * req.logoPaddingFraction);
    const { x, y } = cornerXY(corner, W, H, lw, lh, pad);
    // A plain white mark disappears on a bright photo (a beach, a white dress, a lit wall).
    // A soft dark shadow underneath keeps it legible on light and dark alike, without the
    // solid backing box that reads as a sticker.
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = Math.max(2, Math.round(lw * 0.06));
    ctx.drawImage(logo, x, y, lw, lh);
    ctx.restore();

    const finalId = ctx.getImageData(0, 0, W, H);
    const buf = await encodeAvif(finalId, { quality: req.quality, speed: req.speed });
    return { id: req.id, ok: true, buffer: buf, width: W, height: H };
  } catch (e) {
    src?.close();
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

self.onmessage = async (e: MessageEvent<ProcessRequest>) => {
  const res = await process(e.data);
  // Hand the encoded bytes over rather than copying them.
  if (res.ok) (self as unknown as Worker).postMessage(res, [res.buffer]);
  else (self as unknown as Worker).postMessage(res);
};
