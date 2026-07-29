/**
 * Local YYYY-MM-DD. Deliberately not `toISOString()` on the raw date: an upload at 01:00
 * Athens time would land on the previous UTC day and split one night across two events.
 */
export function today(now: Date = new Date()): string {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export const isValidDate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00.000Z`).toISOString().slice(0, 10) === s;

/** e.g. "Τετάρτη 29 Ιουλίου 2026" — used for the public page's heading. */
export function formatGreek(date: string): string {
  if (!isValidDate(date)) return date;
  return new Date(`${date}T12:00:00`).toLocaleDateString('el-GR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}
