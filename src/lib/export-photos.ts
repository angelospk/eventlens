/**
 * Getting a batch of photos off the manager's screen and into a social post.
 *
 * There is no single right answer here, because the two devices want opposite things:
 *
 *  - On a phone, a ZIP is close to useless. It lands in Files, not Photos, and the
 *    photo pickers in Instagram and the rest only read Photos. The native share sheet
 *    (`navigator.share` with files) does exactly what is wanted instead: "Save N
 *    Images" straight to the camera roll, or hand them to the app directly.
 *  - On a desktop there is no share sheet, and a browser will not fire twenty
 *    downloads in a row without the user fighting a permission prompt. One ZIP is the
 *    civilised answer.
 *
 * So the strategy is chosen from what the browser can actually do, not from a
 * user-agent guess.
 */

export type ExportStrategy = 'share' | 'zip';

export interface ShareCapableNavigator {
  share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>;
  canShare?: (data: { files?: File[] }) => boolean;
}

/**
 * `canShare` must be asked with a real File — every browser exposes `share`, and
 * several expose `canShare` while still refusing files. A probe file is the only
 * honest test.
 */
export function pickExportStrategy(nav: ShareCapableNavigator | undefined): ExportStrategy {
  if (!nav?.share || !nav.canShare) return 'zip';
  try {
    const probe = new File([new Uint8Array([0])], 'probe.webp', { type: 'image/webp' });
    return nav.canShare({ files: [probe] }) ? 'share' : 'zip';
  } catch {
    return 'zip';
  }
}

/**
 * A download name per photo, based on the name the photographer's file had.
 *
 * Two photographers on the same night routinely produce the same `IMG_1234.jpg`, and
 * a ZIP with duplicate entries — or a share sheet saving one file twice — loses
 * photos silently. Collisions get a numeric suffix.
 */
export function exportFilenames(
  items: Array<{ id: string; original_name?: string | null; public_url: string }>
): string[] {
  // Every name that has actually been handed out, not just the originals. Counting
  // originals alone means `IMG.jpg, IMG.jpg, IMG-2.jpg` produces `IMG-2` twice, and
  // the second one quietly overwrites the first on extraction.
  const used = new Set<string>();
  return items.map((item) => {
    const base = (item.original_name || item.id).replace(/\.[^./]+$/, '').replace(/[/\\]/g, '_');
    const ext = item.public_url.match(/\.(webp|jpg|jpeg|avif|png)(?:\?|$)/i)?.[1]?.toLowerCase() ?? 'webp';
    let name = `${base}.${ext}`;
    // Compared case-insensitively: the manager is on macOS or Windows, where a
    // filesystem treats IMG.webp and img.webp as the same file.
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}-${n}.${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

// ---------------------------------------------------------------------------
// ZIP writing
//
// Store-only (method 0): the entries are already WebP/JPEG, so deflating them buys
// nothing and costs the phone a lot of CPU. No zip64 — a night of photos is nowhere
// near 4GB, and the manager would not be downloading it in one go if it were.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!)! & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, which is what a ZIP entry stores. Seconds have 2s resolution. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/**
 * Build a ZIP from entries already in memory.
 *
 * Flag bit 11 is set so the name is read as UTF-8 — Greek filenames come out of this
 * app routinely, and without it they arrive mojibake'd.
 */
export function buildZip(entries: ZipEntry[], now: Date = new Date()): Uint8Array {
  const { time, date } = dosDateTime(now);
  const enc = new TextEncoder();
  const prepared = entries.map((e) => ({
    nameBytes: enc.encode(e.name),
    bytes: e.bytes,
    crc: crc32(e.bytes)
  }));

  // Classic-ZIP fields are 16 and 32 bit. Past these bounds the values wrap and the
  // archive is silently corrupt, which is far worse than refusing to build it. Zip64
  // would lift them, and is not worth carrying for a night of photos.
  if (prepared.length > 0xffff) {
    throw new Error(`too many files for one archive (${prepared.length}, limit 65535)`);
  }
  for (const e of prepared) {
    if (e.nameBytes.length > 0xffff) throw new Error('a filename is too long for a zip entry');
  }
  const total = prepared.reduce((n, e) => n + e.bytes.length, 0);
  if (total > 0xffffffff) throw new Error('archive would exceed the 4GB zip limit');

  const LOCAL = 30;
  const CENTRAL = 46;
  const EOCD = 22;
  const localSize = prepared.reduce((n, e) => n + LOCAL + e.nameBytes.length + e.bytes.length, 0);
  const centralSize = prepared.reduce((n, e) => n + CENTRAL + e.nameBytes.length, 0);

  const out = new Uint8Array(localSize + centralSize + EOCD);
  const view = new DataView(out.buffer);
  let off = 0;
  const u16 = (v: number) => {
    view.setUint16(off, v, true);
    off += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(off, v >>> 0, true);
    off += 4;
  };
  const raw = (b: Uint8Array) => {
    out.set(b, off);
    off += b.length;
  };

  const offsets: number[] = [];
  for (const e of prepared) {
    offsets.push(off);
    u32(0x04034b50); // local file header
    u16(20); // version needed
    u16(0x0800); // flags: UTF-8 name
    u16(0); // method: store
    u16(time);
    u16(date);
    u32(e.crc);
    u32(e.bytes.length); // compressed == uncompressed when stored
    u32(e.bytes.length);
    u16(e.nameBytes.length);
    u16(0); // extra
    raw(e.nameBytes);
    raw(e.bytes);
  }

  const centralStart = off;
  prepared.forEach((e, i) => {
    u32(0x02014b50); // central directory header
    u16(20); // version made by
    u16(20); // version needed
    u16(0x0800);
    u16(0);
    u16(time);
    u16(date);
    u32(e.crc);
    u32(e.bytes.length);
    u32(e.bytes.length);
    u16(e.nameBytes.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk number
    u16(0); // internal attrs
    u32(0); // external attrs
    u32(offsets[i]!);
    raw(e.nameBytes);
  });

  // Measured before the EOCD is written: `off` is a cursor, and reading it inside the
  // block below would count the EOCD's own bytes as part of the directory.
  const centralBytes = off - centralStart;

  u32(0x06054b50); // end of central directory
  u16(0); // this disk
  u16(0); // disk with the central directory
  u16(prepared.length);
  u16(prepared.length);
  u32(centralBytes);
  u32(centralStart);
  u16(0); // comment length

  return out;
}

/** `photos-2026-07-30.zip` — the night is what the manager is thinking in. */
export function zipName(date: string, count: number): string {
  return `eventlens-${date}-${count}.zip`;
}

// ---------------------------------------------------------------------------
// Browser-only from here down. Not unit-tested (needs fetch + DOM + a share sheet);
// the pieces it is built from — strategy choice, naming, zip bytes — all are.
// ---------------------------------------------------------------------------

export interface ExportItem {
  id: string;
  original_name?: string | null;
  public_url: string;
}

export interface ExportProgress {
  done: number;
  total: number;
  phase: 'fetching' | 'packing' | 'sharing';
}

/**
 * Everything is held in memory: the blobs, then a copy as bytes, then the finished
 * archive. Peak is roughly three times the payload, and an iPhone kills the whole web
 * process rather than throwing when that gets out of hand, which looks to the manager
 * like the page reloaded and ate the selection. Refusing early with a number they can
 * act on beats dying silently.
 */
export const MAX_EXPORT_BYTES = 250 * 1024 * 1024;

export class ExportTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`selection is too large to export in one go (${Math.round(bytes / 1024 / 1024)}MB)`);
    this.name = 'ExportTooLargeError';
  }
}

/** Fetch every selected photo, then hand the batch to the share sheet or to a zip. */
export async function exportPhotos(
  items: ExportItem[],
  date: string,
  onProgress?: (p: ExportProgress) => void,
  signal?: AbortSignal
): Promise<{ strategy: ExportStrategy; count: number }> {
  if (!items.length) return { strategy: 'zip', count: 0 };
  const names = exportFilenames(items);
  let strategy = pickExportStrategy(typeof navigator === 'undefined' ? undefined : navigator);

  const blobs: Blob[] = [];
  let bytes = 0;
  for (let i = 0; i < items.length; i++) {
    onProgress?.({ done: i, total: items.length, phase: 'fetching' });
    const res = await fetch(items[i]!.public_url, { signal });
    if (!res.ok) throw new Error(`download failed ${res.status}`);
    const blob = await res.blob();
    bytes += blob.size;
    if (bytes > MAX_EXPORT_BYTES) throw new ExportTooLargeError(bytes);
    blobs.push(blob);
  }

  if (strategy === 'share') {
    onProgress?.({ done: items.length, total: items.length, phase: 'sharing' });
    const files = blobs.map((b, i) => new File([b], names[i]!, { type: b.type }));
    try {
      await (navigator as ShareCapableNavigator).share!({ files });
      return { strategy, count: files.length };
    } catch (e) {
      // Tapping Cancel is not a failure, and must not silently download a zip
      // instead, which would make the cancel look like it did nothing.
      if (e instanceof DOMException && e.name === 'AbortError') return { strategy, count: 0 };
      // Anything else means the share sheet would not take the batch. The usual cause
      // is that fetching the photos outlived the tap that authorised the share, so
      // Safari refuses it. The files are already in hand, so fall back to a zip rather
      // than making the manager start over.
      strategy = 'zip';
    }
  }

  onProgress?.({ done: items.length, total: items.length, phase: 'packing' });
  const entries: ZipEntry[] = [];
  for (let i = 0; i < blobs.length; i++) {
    entries.push({ name: names[i]!, bytes: new Uint8Array(await blobs[i]!.arrayBuffer()) });
  }
  const zip = buildZip(entries);
  triggerDownload(new Blob([zip as BlobPart], { type: 'application/zip' }), zipName(date, entries.length));
  return { strategy, count: entries.length };
}

/** Single photo, whatever the device — one file needs no zip and no share sheet. */
export async function downloadOne(item: ExportItem): Promise<void> {
  const res = await fetch(item.public_url);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  triggerDownload(await res.blob(), exportFilenames([item])[0]!);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking synchronously can cancel the download in some browsers; one turn is enough.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
