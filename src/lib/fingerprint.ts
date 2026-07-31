/**
 * Identifies a chosen file well enough to recognise it if it is chosen again.
 *
 * This is the file's identity (name and size), not a hash of its contents.
 * Hashing would also catch the same image saved twice under different names, but it means
 * reading every byte of every photograph on a phone before anything can be queued, and the
 * duplicate that actually happens at an event is the photographer re-selecting files they
 * already sent. Name and size identify those exactly, instantly, and without touching the
 * data.
 *
 * The trade-off, stated plainly: two genuinely different photographs would have to share a
 * filename and a byte count to be confused, and one photograph copied under two names
 * counts as two.
 */
export function fingerprintOf(file: File): string {
  // Name and size only. The modification time was in here too, until it turned out that
  // the iPhone photo picker exports a fresh copy on each pick and stamps it with the time
  // of the export — so the same photograph chosen twice looked like two different files
  // and went up twice. Dropping it costs almost nothing: two different photographs would
  // now have to share a filename and a byte count exactly.
  return `${file.name}|${file.size}`;
}
