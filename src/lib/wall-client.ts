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
