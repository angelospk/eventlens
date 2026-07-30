/// <reference lib="webworker" />
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
  /** Long edge of the gallery thumbnail, 0 to skip it. */
  thumbLongEdge: number;
  thumbQuality: number;
  /** The exact type the upload was signed for. */
  mime: string;
  logoWidthFraction: number;
  logoPaddingFraction: number;
  grade: { contrast: number; saturate: number; brightness: number };
}

export type ProcessResponse =
  | {
      id: string;
      ok: true;
      buffer: ArrayBuffer;
      /** Absent when the photograph was already small enough, or the thumbnail failed. */
      thumb?: ArrayBuffer;
      width: number;
      height: number;
      mime: string;
    }
  | { id: string; ok: false; error: string };

/**
 * Encodes the finished frame, preferring the browser's own encoder.
 *
 * Three paths, in order of what they cost:
 *
 * 1. Native WebP. Measured on this machine, 2560x1920: 0.5s and 125KB. Free, no download.
 * 2. WebAssembly WebP, for Safari, which cannot encode WebP from a canvas. Costs a one-off
 *    module download and a few seconds of CPU per photo, and produces files roughly a fifth
 *    the size of the JPEG it replaces. At an outdoor festival the upload is the bottleneck,
 *    not the phone, so spending CPU to avoid megabytes is the right trade.
 * 3. Native JPEG, when neither of the above is available.
 *
 * This replaced a wasm AVIF encoder that took about ninety seconds per photo. WebP is a
 * different animal: the AVIF encoder was the slow one, not WebAssembly itself.
 *
 * `convertToBlob` does NOT reject when it cannot produce the format asked for: it quietly
 * returns a PNG, which for a photograph is enormous. So the result is always checked.
 */
async function encodeImage(
  canvas: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D,
  quality: number,
  mime: string,
  width: number,
  height: number
) {
  const q = Math.min(0.95, Math.max(0.5, quality / 100));
  const blob = await canvas.convertToBlob({ type: mime, quality: q });
  if (blob.type === mime) return blob;

  if (mime === 'image/webp') {
    // Safari lands here. The format was already signed as WebP precisely because the probe
    // confirmed this path exists, so failing over to JPEG would send bytes that do not
    // match the signature.
    const { default: encodeWebp } = await import('@jsquash/webp/encode');
    const buf = await encodeWebp(ctx.getImageData(0, 0, width, height), {
      quality,
      // Encoder effort, 0-6. Four is the point where more time stops buying much size.
      method: 4
    });
    return new Blob([buf], { type: mime });
  }

  // The upload was already signed for `mime`, so a silent PNG here would be rejected by
  // storage. Better to fail the photo with a real reason than to send the wrong bytes.
  throw new Error(`ο browser δεν παρήγαγε ${mime}`);
}

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

/**
 * Decodes whatever the photographer picked.
 *
 * `createImageBitmap` covers JPEG, PNG, WebP, GIF and AVIF everywhere, and HEIC on Apple
 * platforms where the OS decoder is wired in. It throws on HEIC everywhere else, which is
 * not an edge case: HEIC is the iPhone default, and a photo copied off a phone or picked
 * through Files arrives untouched.
 *
 * The HEIC decoder is a three megabyte WebAssembly bundle, so it is imported only after a
 * decode has actually failed. A night of JPEGs never pays for it.
 */
async function decode(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch (nativeError) {
    const { isHeic, heicTo } = await import('heic-to/next');
    if (!(await isHeic(blob as File))) throw nativeError;
    const bitmap = await heicTo({ blob, type: 'bitmap' });
    if (!bitmap) throw nativeError;
    return bitmap as ImageBitmap;
  }
}

async function process(req: ProcessRequest): Promise<ProcessResponse> {
  let src: ImageBitmap | null = null;
  try {
    src = await decode(new Blob([req.buffer], { type: req.type }));

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
    // Scaled against the image WIDTH, not the short edge. The mark is a wide wordmark, so
    // sizing it by the short edge makes it look modest on a landscape photo and oversized
    // on a portrait one. Against the width it keeps the same visual weight either way.
    const lw = Math.round(W * req.logoWidthFraction);
    const lh = Math.round((logo.height / logo.width) * lw);
    const pad = Math.round(Math.min(W, H) * req.logoPaddingFraction);
    const { x, y } = cornerXY(corner, W, H, lw, lh, pad);
    // A plain white mark disappears on a bright photo (a beach, a white dress, a lit wall).
    // A soft dark shadow underneath keeps it legible on light and dark alike, without the
    // solid backing box that reads as a sticker.
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = Math.max(2, Math.round(lw * 0.06));
    ctx.drawImage(logo, x, y, lw, lh);
    ctx.restore();

    const blob = await encodeImage(canvas, ctx, req.quality, req.mime, W, H);
    const buf = await blob.arrayBuffer();

    // A small copy for the gallery, drawn from the frame that already carries the grade
    // and the logo so the two never disagree. Visitors were downloading full frames to
    // look at two-hundred-pixel tiles; on a field on mobile data that is most of the
    // page weight for none of the benefit.
    let thumbBuf: ArrayBuffer | undefined;
    if (req.thumbLongEdge > 0 && Math.max(W, H) > req.thumbLongEdge) {
      const ts = req.thumbLongEdge / Math.max(W, H);
      const tw = Math.max(1, Math.round(W * ts));
      const th = Math.max(1, Math.round(H * ts));
      const tCanvas = new OffscreenCanvas(tw, th);
      const tCtx = tCanvas.getContext('2d', { willReadFrequently: true });
      if (tCtx) {
        tCtx.drawImage(canvas, 0, 0, tw, th);
        try {
          const tBlob = await encodeImage(tCanvas, tCtx, req.thumbQuality, req.mime, tw, th);
          thumbBuf = await tBlob.arrayBuffer();
        } catch {
          // A thumbnail is an optimisation, never a reason to lose the photograph.
        }
      }
    }

    return { id: req.id, ok: true, buffer: buf, thumb: thumbBuf, width: W, height: H, mime: req.mime };
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
