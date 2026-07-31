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
  // `retryable` separates "this file cannot be processed" from "the code needed to process
  // it could not be fetched". The second is a network failure wearing the first's clothes,
  // and treating it as a broken photograph retires a perfectly good one permanently.
  | { id: string; ok: false; error: string; retryable?: boolean };

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
    const { default: encodeWebp } = await loadable(
      () => import('@jsquash/webp/encode'),
      'WebP encoder'
    );
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
/**
 * A marker for "the module itself would not load", which on a phone in a field is almost
 * always the signal dropping mid-fetch rather than anything wrong with the photograph.
 */
class ChunkLoadError extends Error {
  readonly retryable = true;
  constructor(what: string, cause: unknown) {
    super(`${what} δεν κατέβηκε: ${cause instanceof Error ? cause.message : cause}`);
  }
}

async function loadable<T>(load: () => Promise<T>, what: string): Promise<T> {
  try {
    return await load();
  } catch (e) {
    throw new ChunkLoadError(what, e);
  }
}

async function decode(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch (nativeError) {
    const { isHeic, heicTo } = await loadable(() => import('heic-to/next'), 'HEIC decoder');
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
    let id: ImageData | null = ctx.getImageData(0, 0, W, H);
    grade(id.data, req.grade);
    const px: Pixels = { data: id.data, width: W, height: H };
    const corner = quietestCorner(px);
    ctx.putImageData(id, 0, 0);
    // Twenty megabytes for a phone photograph, and nothing below needs it. Dropping the
    // reference now lets it be collected before the encoder asks for its own copy.
    id = null;

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

    // The gallery copy is taken FIRST, while memory is at its calmest.
    //
    // Order matters more than it looks on a phone. A full frame at this size is about
    // twenty megabytes of pixels; encoding it allocates another copy for the encoder, and
    // on Safari the WebAssembly encoder needs a third. Doing the small copy afterwards
    // means asking for yet another canvas at the exact moment the process is already at
    // its peak, and iOS answers that by killing the tab, which is what "it breaks after
    // the second photograph" looks like from the outside.
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
      // Hand the small canvas back to the collector rather than waiting for the next
      // photograph to pressure it out.
      tCanvas.width = tCanvas.height = 0;
    }

    const blob = await encodeImage(canvas, ctx, req.quality, req.mime, W, H);
    // Releasing the backing store here rather than at the end of the function means the
    // twenty megabytes are gone before the ArrayBuffer copy below, not after it.
    canvas.width = canvas.height = 0;
    const buf = await blob.arrayBuffer();

    return { id: req.id, ok: true, buffer: buf, thumb: thumbBuf, width: W, height: H, mime: req.mime };
  } catch (e) {
    src?.close();
    return {
      id: req.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      retryable: e instanceof ChunkLoadError
    };
  }
}

self.onmessage = async (e: MessageEvent<ProcessRequest>) => {
  const res = await process(e.data);
  // Hand the encoded bytes over rather than copying them.
  if (res.ok) (self as unknown as Worker).postMessage(res, [res.buffer]);
  else (self as unknown as Worker).postMessage(res);
};
