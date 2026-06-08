import type { PhotoListItem } from './types';

export interface ManagerDeps {
  workerUrl: string;
  passcode: string;
  fetchImpl?: typeof fetch;
}

export async function fetchList(deps: ManagerDeps, date: string): Promise<PhotoListItem[]> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(`${deps.workerUrl}/list?date=${encodeURIComponent(date)}`, {
    method: 'GET',
    headers: { 'x-manager-passcode': deps.passcode }
  });
  if (!res.ok) throw new Error(`list failed ${res.status}`);
  const body = (await res.json()) as { photos: PhotoListItem[] };
  return body.photos;
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
