import type { FetchLike } from './types';

export type Role = 'photographer' | 'manager';

export interface AuthDeps {
  workerUrl: string;
  fetchImpl?: FetchLike;
}

export interface TokenGrant {
  role: Role;
  token: string;
  expiresAt: number; // epoch seconds
}

/**
 * Exchanges a passcode for a short-lived token.
 *
 * Returns the grant on success and null when the passcode is rejected (401, 403) or the
 * server is throttling guesses (429). Any other outcome throws: an unreachable network,
 * but also a 5xx. Callers treat a throw as "cannot tell yet" rather than "wrong passcode",
 * which is what lets the photographer keep working with no signal.
 */
export async function requestToken(
  deps: AuthDeps,
  passcode: string,
  role: Role
): Promise<TokenGrant | null> {
  const f = deps.fetchImpl ?? fetch;
  const header = role === 'manager' ? 'x-manager-passcode' : 'x-passcode';
  const res = await f(`${deps.workerUrl}/auth`, {
    method: 'GET',
    headers: { [header]: passcode },
    cache: 'no-store'
  });
  // 403 is grouped with 401 here and in classifyStatus: both mean this passcode will never
  // work. 429 means too many wrong guesses, which is also not something to retry into.
  if (res.status === 401 || res.status === 403 || res.status === 429) return null;
  if (!res.ok) throw new Error(`auth failed ${res.status}`);
  return (await res.json()) as TokenGrant;
}
