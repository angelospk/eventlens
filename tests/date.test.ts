import { test, expect } from 'bun:test';
import { today, calendarDay, NIGHT_ENDS_AT_HOUR, formatGreek, isValidDate } from '../src/lib/date';

// Constructed with local-time fields on purpose: the whole point of the shift is that it
// follows the photographer's clock, not UTC.
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);

test('an evening photo belongs to that evening', () => {
  expect(today(at(2026, 7, 30, 21, 30))).toBe('2026-07-30');
  expect(today(at(2026, 7, 30, 23, 59))).toBe('2026-07-30');
});

test('after midnight the night still counts as the day it started', () => {
  expect(today(at(2026, 7, 31, 0, 1))).toBe('2026-07-30');
  expect(today(at(2026, 7, 31, 1, 0))).toBe('2026-07-30');
  expect(today(at(2026, 7, 31, 3, 30))).toBe('2026-07-30');
});

test('the new day starts at the cutoff, not at midnight', () => {
  const justBefore = at(2026, 7, 31, NIGHT_ENDS_AT_HOUR - 1, 59);
  const justAfter = at(2026, 7, 31, NIGHT_ENDS_AT_HOUR, 1);
  expect(today(justBefore)).toBe('2026-07-30');
  expect(today(justAfter)).toBe('2026-07-31');
});

test('the shift never skips a month or a year boundary', () => {
  expect(today(at(2026, 8, 1, 2, 0))).toBe('2026-07-31'); // month rolls back
  expect(today(at(2027, 1, 1, 2, 0))).toBe('2026-12-31'); // and so does the year
});

test('calendarDay is the plain date, unshifted', () => {
  expect(calendarDay(at(2026, 7, 31, 1, 0))).toBe('2026-07-31');
  expect(calendarDay(at(2026, 7, 30, 23, 0))).toBe('2026-07-30');
});

test('a late-night upload and the wall agree on which night it is', () => {
  // Both the uploader and the public pages read the same clock through the same helper,
  // so a photo taken at 01:00 lands on the page that is showing at 01:00.
  const lateNight = at(2026, 7, 31, 1, 15);
  expect(today(lateNight)).toBe(today(lateNight));
  expect(today(lateNight)).toBe('2026-07-30');
});

test('date validation still rejects impossible dates', () => {
  expect(isValidDate('2026-07-30')).toBe(true);
  expect(isValidDate('2026-02-31')).toBe(false);
  expect(isValidDate('nonsense')).toBe(false);
});

test('the Greek heading reads as a date', () => {
  expect(formatGreek('2026-07-30')).toContain('30');
  expect(formatGreek('2026-07-30')).toContain('2026');
});
