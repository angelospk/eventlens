import type { WallPhoto, Sponsor } from './types';

export interface WallDeps {
  workerUrl: string;
  fetchImpl?: typeof fetch;
}

// Public (no passcode): confirmed photos for one event date from the Worker's GET /wall.
export async function fetchWallPhotos(deps: WallDeps, date: string): Promise<WallPhoto[]> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(`${deps.workerUrl}/wall?date=${encodeURIComponent(date)}`, { method: 'GET' });
  if (!res.ok) throw new Error(`wall fetch failed ${res.status}`);
  const body = (await res.json()) as { photos?: WallPhoto[] };
  return body.photos ?? [];
}

// Loads the sponsors JSON (same-origin). `url` is built by the caller against the SvelteKit base
// path. Degrades to [] on any failure (missing file, bad JSON, non-array) so a misconfigured file
// never breaks the wall.
export async function loadSponsors(url: string, fetchImpl: typeof fetch = fetch): Promise<Sponsor[]> {
  try {
    const res = await fetchImpl(url, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as Sponsor[]) : [];
  } catch {
    return [];
  }
}
