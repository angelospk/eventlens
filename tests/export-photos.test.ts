import { describe, expect, it } from 'bun:test';
import {
  buildZip,
  crc32,
  exportFilenames,
  pickExportStrategy,
  zipName
} from '../src/lib/export-photos';

describe('pickExportStrategy', () => {
  it('shares when the browser will actually take files', () => {
    expect(pickExportStrategy({ share: async () => {}, canShare: () => true })).toBe('share');
  });

  // Every browser has `share`; plenty have `canShare` and still refuse files. Asking
  // with a real File is the only answer worth trusting.
  it('falls back to a zip when canShare refuses files', () => {
    expect(pickExportStrategy({ share: async () => {}, canShare: () => false })).toBe('zip');
  });

  it('falls back to a zip on a desktop browser with no share sheet', () => {
    expect(pickExportStrategy({})).toBe('zip');
    expect(pickExportStrategy(undefined)).toBe('zip');
  });

  it('falls back to a zip when canShare throws', () => {
    expect(
      pickExportStrategy({
        share: async () => {},
        canShare: () => {
          throw new Error('nope');
        }
      })
    ).toBe('zip');
  });
});

describe('exportFilenames', () => {
  const item = (id: string, original_name: string | null, url = 'https://x/y/z.webp') => ({
    id,
    original_name,
    public_url: url
  });

  it('keeps the photographer’s name and the stored extension', () => {
    expect(exportFilenames([item('a', 'IMG_1234.HEIC')])).toEqual(['IMG_1234.webp']);
    expect(exportFilenames([item('a', 'party.jpg', 'https://x/y/z.jpg')])).toEqual(['party.jpg']);
  });

  it('falls back to the id when there is no original name', () => {
    expect(exportFilenames([item('abc-123', null)])).toEqual(['abc-123.webp']);
  });

  // Two photographers on one night produce IMG_1234.jpg twice; a zip with duplicate
  // entries loses a photo without saying so.
  it('suffixes collisions instead of overwriting', () => {
    expect(
      exportFilenames([item('a', 'IMG_1.jpg'), item('b', 'IMG_1.jpg'), item('c', 'IMG_1.jpg')])
    ).toEqual(['IMG_1.webp', 'IMG_1-2.webp', 'IMG_1-3.webp']);
  });

  // The suffix has to dodge names that already exist too. Counting only the original
  // stems produced IMG-2 twice here, and the second one overwrote the first on
  // extraction: a photo lost with nothing to show for it.
  it('does not collide with a name that a suffix would produce', () => {
    const names = exportFilenames([item('a', 'IMG.jpg'), item('b', 'IMG.jpg'), item('c', 'IMG-2.jpg')]);
    expect(new Set(names).size).toBe(3);
    // The third photo really is called IMG-2, and IMG-2 is already taken by the
    // suffixed second one, so it suffixes in turn rather than stealing the name.
    expect(names).toEqual(['IMG.webp', 'IMG-2.webp', 'IMG-2-2.webp']);
  });

  // The manager is on macOS or Windows, where IMG.webp and img.webp are one file.
  it('treats names that differ only in case as colliding', () => {
    const names = exportFilenames([item('a', 'Photo.jpg'), item('b', 'photo.jpg')]);
    expect(names[0]!.toLowerCase()).not.toBe(names[1]!.toLowerCase());
  });

  it('strips path separators out of a hostile name', () => {
    expect(exportFilenames([item('a', '../../etc/passwd.jpg')])).toEqual(['.._.._etc_passwd.webp']);
  });
});

describe('crc32', () => {
  // Standard vectors — a wrong CRC produces a zip that only fails at extraction time.
  it('matches known values', () => {
    const b = (s: string) => new TextEncoder().encode(s);
    expect(crc32(b(''))).toBe(0);
    expect(crc32(b('a'))).toBe(0xe8b7be43);
    expect(crc32(b('123456789'))).toBe(0xcbf43926);
    expect(crc32(b('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });
});

describe('buildZip', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const read32 = (z: Uint8Array, off: number) => new DataView(z.buffer).getUint32(off, true);
  const read16 = (z: Uint8Array, off: number) => new DataView(z.buffer).getUint16(off, true);

  it('writes the three signatures a zip reader looks for', () => {
    const z = buildZip([{ name: 'a.txt', bytes: bytes('hello') }]);
    expect(read32(z, 0)).toBe(0x04034b50); // local header
    expect(read32(z, z.length - 22)).toBe(0x06054b50); // end of central directory
    const cdOffset = read32(z, z.length - 22 + 16);
    expect(read32(z, cdOffset)).toBe(0x02014b50); // central directory
  });

  it('records the entry count in both EOCD fields', () => {
    const z = buildZip([
      { name: 'a.txt', bytes: bytes('one') },
      { name: 'b.txt', bytes: bytes('two') }
    ]);
    expect(read16(z, z.length - 22 + 8)).toBe(2);
    expect(read16(z, z.length - 22 + 10)).toBe(2);
  });

  it('stores rather than compresses, so sizes match and the payload is verbatim', () => {
    const payload = bytes('some already-compressed image bytes');
    const z = buildZip([{ name: 'a.webp', bytes: payload }]);
    expect(read16(z, 8)).toBe(0); // method 0 = store
    expect(read32(z, 18)).toBe(payload.length); // compressed size
    expect(read32(z, 22)).toBe(payload.length); // uncompressed size
    expect(read32(z, 14)).toBe(crc32(payload));
    const nameLen = read16(z, 26);
    expect(z.slice(30 + nameLen, 30 + nameLen + payload.length)).toEqual(payload);
  });

  // Greek filenames are the norm in this app; without the UTF-8 flag they arrive mangled.
  it('flags names as UTF-8 and round-trips a Greek one', () => {
    const name = 'φωτογραφία.webp';
    const z = buildZip([{ name, bytes: bytes('x') }]);
    expect(read16(z, 6) & 0x0800).toBe(0x0800);
    const nameLen = read16(z, 26);
    expect(new TextDecoder().decode(z.slice(30, 30 + nameLen))).toBe(name);
  });

  it('points each central directory record at its local header', () => {
    const z = buildZip([
      { name: 'a.txt', bytes: bytes('one') },
      { name: 'b.txt', bytes: bytes('two') }
    ]);
    const cdOffset = read32(z, z.length - 22 + 16);
    expect(read32(z, cdOffset + 42)).toBe(0); // first entry starts the file
    const second = cdOffset + 46 + read16(z, cdOffset + 28);
    const secondLocal = read32(z, second + 42);
    expect(read32(z, secondLocal)).toBe(0x04034b50);
  });

  // Regression: the directory size used to be measured after the EOCD had begun
  // writing, so it was reported 12 bytes too long. Structure looked fine; a real
  // unzip refused it.
  it('reports a central directory size that matches the bytes actually written', () => {
    for (const entries of [
      [{ name: 'a.txt', bytes: bytes('one') }],
      [
        { name: 'a.txt', bytes: bytes('one') },
        { name: 'β.txt', bytes: bytes('two') },
        { name: 'c.txt', bytes: bytes('three') }
      ]
    ]) {
      const z = buildZip(entries);
      const eocd = z.length - 22;
      const cdSize = read32(z, eocd + 12);
      const cdOffset = read32(z, eocd + 16);
      expect(cdOffset + cdSize).toBe(eocd);
    }
  });

  // Past these bounds the 16 and 32 bit header fields wrap and the archive is
  // silently corrupt, which is worse than refusing to build it.
  it('refuses to emit an archive that would overflow a classic zip field', () => {
    const many = Array.from({ length: 0x10000 }, (_, i) => ({ name: `${i}.txt`, bytes: bytes('x') }));
    expect(() => buildZip(many)).toThrow(/too many files/);
    expect(() => buildZip([{ name: 'x'.repeat(0x10000), bytes: bytes('x') }])).toThrow(/too long/);
  });

  it('produces a valid empty archive', () => {
    const z = buildZip([]);
    expect(z.length).toBe(22);
    expect(read32(z, 0)).toBe(0x06054b50);
  });
});

describe('zipName', () => {
  it('names the archive after the night', () => {
    expect(zipName('2026-07-30', 12)).toBe('eventlens-2026-07-30-12.zip');
  });
});
