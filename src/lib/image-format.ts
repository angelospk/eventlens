/**
 * Which format this browser can actually encode.
 *
 * Asked once per session, before any photograph is signed, because the server builds the
 * object key and signs the exact content type from it. `convertToBlob` and `toBlob` do not
 * fail when they cannot produce the format requested: they quietly hand back a PNG, which
 * for a photograph is several megabytes. So the answer comes from actually encoding a
 * pixel and reading what came out, not from a feature string.
 *
 * WebP is the target: every current browser encodes it, it is a fraction of the size of
 * JPEG, and it costs no WebAssembly download and almost no battery. JPEG is the fallback
 * for anything too old.
 */
export interface OutputFormat {
  mime: string;
  ext: string;
}

const JPEG: OutputFormat = { mime: 'image/jpeg', ext: 'jpg' };
const WEBP: OutputFormat = { mime: 'image/webp', ext: 'webp' };

let cached: Promise<OutputFormat> | null = null;

async function probe(): Promise<OutputFormat> {
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(1, 1);
      c.getContext('2d');
      const blob = await c.convertToBlob({ type: WEBP.mime });
      return blob.type === WEBP.mime ? WEBP : JPEG;
    }
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    c.getContext('2d');
    // toDataURL reports the type it fell back to in the prefix.
    return c.toDataURL(WEBP.mime).startsWith('data:image/webp') ? WEBP : JPEG;
  } catch {
    return JPEG;
  }
}

export function detectOutputFormat(): Promise<OutputFormat> {
  cached ??= probe();
  return cached;
}
