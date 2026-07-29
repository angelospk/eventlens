import type { FetchLike } from './types';

export type Role = 'photographer' | 'manager';

export interface AuthDeps {
  workerUrl: string;
  fetchImpl?: FetchLike;
}

/**
 * Checks a passcode against the Worker before the user starts working. Without this a typo
 * only surfaces once photos are already queued, and every one of them fails.
 *
 * Returns the role on success and null when the passcode is rejected (401 or 403). Any
 * other outcome throws: an unreachable network, but also a 5xx. Callers treat a throw as
 * "cannot tell yet" rather than "wrong passcode", which is what lets the photographer keep
 * working offline while the queue verifies the passcode later.
 */
export async function verifyPasscode(
  deps: AuthDeps,
  passcode: string,
  role: Role
): Promise<Role | null> {
  const f = deps.fetchImpl ?? fetch;
  const header = role === 'manager' ? 'x-manager-passcode' : 'x-passcode';
  const res = await f(`${deps.workerUrl}/auth`, {
    method: 'GET',
    headers: { [header]: passcode },
    cache: 'no-store'
  });
  // 403 is grouped with 401 here and in classifyStatus: both mean this passcode will never
  // work, so the user must be told now rather than after a queue full of failures.
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`auth failed ${res.status}`);
  const body = (await res.json()) as { role: Role };
  return body.role;
}
