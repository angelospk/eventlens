/**
 * Which format this browser can actually produce, and which one to ask it for.
 *
 * Asked once per session, before any photograph is signed, because the server builds the
 * object key and signs the exact content type from it. `convertToBlob` and `toBlob` do not
 * fail when they cannot produce the format requested: they quietly hand back a PNG, which
 * for a photograph is several megabytes. So the answer comes from actually encoding a
 * pixel and reading what came out, not from a feature string.
 *
 * WebP is the target everywhere. Most browsers encode it natively for free. Safari cannot
 * encode it from a canvas at all, and its JPEG measured about twice the size for the same
 * frame, so there it is worth pulling in a WebAssembly encoder: at an outdoor event the
 * upload is the bottleneck, not the phone. JPEG is the answer only where neither path
 * exists, or when the photographer overrides the choice.
 */
export interface OutputFormat {
  mime: string;
  ext: string;
}

export const JPEG: OutputFormat = { mime: 'image/jpeg', ext: 'jpg' };
export const WEBP: OutputFormat = { mime: 'image/webp', ext: 'webp' };

/** 'auto' picks the smallest format the device can manage; the rest force one. */
export type FormatPreference = 'auto' | 'webp' | 'jpeg';

const PREF_KEY = 'eventlens.format.v1';

export function loadPreference(): FormatPreference {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === 'webp' || v === 'jpeg' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function savePreference(pref: FormatPreference) {
  try {
    if (pref === 'auto') localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, pref);
  } catch {
    // Not remembered across reloads; the session still honours it.
  }
  cached = null; // the next photograph re-decides
}

export async function nativeWebp(): Promise<boolean> {
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
export async function wasmWebp(): Promise<boolean> {
  try {
    await import('@jsquash/webp/encode');
    return true;
  } catch {
    return false;
  }
}

let cached: Promise<OutputFormat> | null = null;

async function probe(): Promise<OutputFormat> {
  const pref = loadPreference();
  // A forced JPEG needs no checking: every browser that can draw a canvas can write one.
  if (pref === 'jpeg') return JPEG;
  if (await nativeWebp()) return WEBP;
  if (await wasmWebp()) return WEBP;
  // Asked for WebP and the device cannot do it either way. Sending JPEG is better than
  // refusing the photograph, and the diagnostic explains why the choice was ignored.
  return JPEG;
}

export function detectOutputFormat(): Promise<OutputFormat> {
  cached ??= probe();
  return cached;
}
