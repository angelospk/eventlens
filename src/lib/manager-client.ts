import type { EventSettings, Moderation, PhotoListItem, FetchLike } from './types';
import type { AuthHeaders } from './session';

export interface ManagerDeps {
  workerUrl: string;
  auth: AuthHeaders;
  fetchImpl?: FetchLike;
}

const postHeaders = async (deps: ManagerDeps) => ({
  ...(await deps.auth()),
  'content-type': 'application/json'
});

export interface ListResult {
  photos: PhotoListItem[];
  event: EventSettings;
}

export async function fetchList(deps: ManagerDeps, date: string): Promise<ListResult> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(`${deps.workerUrl}/list?date=${encodeURIComponent(date)}`, {
    method: 'GET',
    headers: await deps.auth(),
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`list failed ${res.status}`);
  const body = (await res.json()) as ListResult;
  return { photos: body.photos ?? [], event: body.event };
}

/** approve | hide | pending for one photo. */
export async function moderatePhoto(
  deps: ManagerDeps,
  id: string,
  action: 'approve' | 'hide' | 'pending'
): Promise<Moderation> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(`${deps.workerUrl}/moderate`, {
    method: 'POST',
    headers: await postHeaders(deps),
    body: JSON.stringify({ id, action })
  });
  if (!res.ok) throw new Error(`moderate failed ${res.status}`);
  const body = (await res.json()) as { moderation: Moderation };
  return body.moderation;
}

/** Same action across every reviewable photo of a night — the "approve everything" button. */
export async function moderateAll(
  deps: ManagerDeps,
  date: string,
  action: 'approve' | 'hide' | 'pending'
): Promise<number> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(`${deps.workerUrl}/moderate`, {
    method: 'POST',
    headers: await postHeaders(deps),
    body: JSON.stringify({ date, action, all: true })
  });
  if (!res.ok) throw new Error(`moderate all failed ${res.status}`);
  const body = (await res.json()) as { changed: number };
  return body.changed ?? 0;
}

/** Permanent: removes the object from storage and the row from the database. */
export async function deletePhoto(deps: ManagerDeps, id: string): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(`${deps.workerUrl}/delete`, {
    method: 'POST',
    headers: await postHeaders(deps),
    body: JSON.stringify({ id })
  });
  if (!res.ok) throw new Error(`delete failed ${res.status}`);
}

export async function saveEvent(
  deps: ManagerDeps,
  settings: { date: string; title?: string | null; autoApprove: boolean }
): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(`${deps.workerUrl}/event`, {
    method: 'POST',
    headers: await postHeaders(deps),
    body: JSON.stringify(settings)
  });
  if (!res.ok) throw new Error(`event save failed ${res.status}`);
}

// Browser-only: fetch the public object as a blob and trigger a download with the
// original base name + .avif extension. Not unit-tested (needs DOM); manual smoke.
export async function downloadPhoto(item: PhotoListItem): Promise<void> {
  const res = await fetch(item.public_url);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  const base = (item.original_name || item.id).replace(/\.[^./]+$/, '');
  a.download = `${base}.avif`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}
