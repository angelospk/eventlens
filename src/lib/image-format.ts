/**
 * Which format this browser can actually produce.
 *
 * Asked once per session, before any photograph is signed, because the server builds the
 * object key and signs the exact content type from it. `convertToBlob` and `toBlob` do not
 * fail when they cannot produce the format requested: they quietly hand back a PNG, which
 * for a photograph is several megabytes. So the answer comes from actually encoding a
 * pixel and reading what came out, not from a feature string.
 *
 * WebP is the target everywhere. Most browsers encode it natively for free. Safari cannot
 * encode it from a canvas at all, and its JPEG output measured around five times the size
 * per megapixel, so there it is worth pulling in a WebAssembly encoder: at an outdoor event
 * the upload is the bottleneck, not the phone. JPEG remains the answer only where neither
 * path exists.
 */
export interface OutputFormat {
  mime: string;
  ext: string;
}

const JPEG: OutputFormat = { mime: 'image/jpeg', ext: 'jpg' };
const WEBP: OutputFormat = { mime: 'image/webp', ext: 'webp' };

let cached: Promise<OutputFormat> | null = null;

async function nativeWebp(): Promise<boolean> {
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(1, 1);
      c.getContext('2d');
      return (await c.convertToBlob({ type: WEBP.mime })).type === WEBP.mime;
    }
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    c.getContext('2d');
    // toDataURL reports the type it fell back to in the prefix.
    return c.toDataURL(WEBP.mime).startsWith('data:image/webp');
  } catch {
    return false;
  }
}

/**
 * Confirms the WebAssembly encoder can be loaded, and warms it, before promising the server
 * a WebP. Doing this at sign-in rather than on the first photograph means the download
 * happens while the photographer is still finding their feet, not while a queue waits.
 */
async function wasmWebp(): Promise<boolean> {
  try {
    await import('@jsquash/webp/encode');
    return true;
  } catch {
    return false;
  }
}

async function probe(): Promise<OutputFormat> {
  if (await nativeWebp()) return WEBP;
  if (await wasmWebp()) return WEBP;
  return JPEG;
}

export function detectOutputFormat(): Promise<OutputFormat> {
  cached ??= probe();
  return cached;
}
