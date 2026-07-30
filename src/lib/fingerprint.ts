/**
 * Identifies a chosen file well enough to recognise it if it is chosen again.
 *
 * This is the file's identity (name, size, modification time), not a hash of its contents.
 * Hashing would also catch the same image saved twice under different names, but it means
 * reading every byte of every photograph on a phone before anything can be queued, and the
 * duplicate that actually happens at an event is the photographer re-selecting files they
 * already sent. Name, size and timestamp identify those exactly, instantly, and without
 * touching the data.
 *
 * The trade-off, stated plainly: two genuinely different photographs would have to share a
 * filename, a byte count and a modification timestamp to be confused, and one photograph
 * copied under two names counts as two.
 */
export function fingerprintOf(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}
