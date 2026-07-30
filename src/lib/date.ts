/**
 * How late a night still counts as the previous day.
 *
 * An event does not stop at midnight. Photographs taken at half past one on the 31st
 * belong to the night of the 30th, and filing them under the 31st would split one evening
 * across two galleries and put the small hours on a page whose event has not started yet.
 *
 * Everything before this hour, local time, is filed under yesterday.
 */
export const NIGHT_ENDS_AT_HOUR = 5;

/** Local YYYY-MM-DD for a given moment, with no shifting. */
function localDay(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/**
 * The event date a photograph taken now belongs to.
 *
 * Deliberately not `toISOString()` on the raw date: an upload at 01:00 Athens time would
 * land on the previous UTC day and split one night across two events for a different and
 * much more confusing reason.
 */
export function today(now: Date = new Date()): string {
  const shifted = new Date(now);
  shifted.setHours(shifted.getHours() - NIGHT_ENDS_AT_HOUR);
  return localDay(shifted);
}

/** The plain calendar day, for anything that genuinely means "the date on the wall". */
export const calendarDay = (now: Date = new Date()): string => localDay(now);

export const isValidDate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00.000Z`).toISOString().slice(0, 10) === s;

/** e.g. "30 Ιουλίου" — short enough for a header, clear enough at two in the morning. */
export function formatNight(date: string): string {
  if (!isValidDate(date)) return date;
  return new Date(`${date}T12:00:00`).toLocaleDateString('el-GR', { day: 'numeric', month: 'long' });
}

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
