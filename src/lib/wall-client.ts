import type { WallPhoto, Sponsor, FetchLike } from './types';

export interface WallDeps {
  workerUrl: string;
  fetchImpl?: FetchLike;
}

export interface WallResult {
  date: string;
  title: string | null;
  photos: WallPhoto[];
}

// Public (no passcode): approved photos for one night from the Worker's GET /wall.
// The response is edge-cached, so many simultaneous viewers cost very few database reads.
export async function fetchWall(deps: WallDeps, date: string): Promise<WallResult> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(`${deps.workerUrl}/wall?date=${encodeURIComponent(date)}`, { method: 'GET' });
  if (!res.ok) throw new Error(`wall fetch failed ${res.status}`);
  const body = (await res.json()) as Partial<WallResult>;
  return { date: body.date ?? date, title: body.title ?? null, photos: body.photos ?? [] };
}

export interface EventDay {
  date: string;
  count: number;
  title: string | null;
}

export interface DaysResult {
  days: EventDay[];
  /** The night to show when the visitor has not asked for one. Null before anything is up. */
  defaultDate: string | null;
}

/**
 * Every night that has photographs, newest first.
 *
 * The embedded gallery is one iframe for the whole festival, so this is what makes a new
 * evening appear on the host page on its own. Degrades to an empty list: a gallery with no
 * tabs still shows a night, while a thrown error would show nothing at all.
 */
export async function fetchDays(deps: WallDeps): Promise<DaysResult> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(`${deps.workerUrl}/days`, { method: 'GET' });
  if (!res.ok) throw new Error(`days fetch failed ${res.status}`);
  const body = (await res.json()) as Partial<DaysResult>;
  const days = Array.isArray(body.days) ? body.days : [];
  return { days, defaultDate: body.defaultDate ?? days[0]?.date ?? null };
}

/** Back-compat helper for callers that only need the photos. */
export async function fetchWallPhotos(deps: WallDeps, date: string): Promise<WallPhoto[]> {
  return (await fetchWall(deps, date)).photos;
}

// Loads the sponsors JSON (same-origin). `url` is built by the caller against the SvelteKit base
// path. Degrades to [] on any failure (missing file, bad JSON, non-array) so a misconfigured file
// never breaks the wall.
export async function loadSponsors(url: string, fetchImpl: FetchLike = fetch): Promise<Sponsor[]> {
  try {
    const res = await fetchImpl(url, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as Sponsor[]) : [];
  } catch {
    return [];
  }
}
