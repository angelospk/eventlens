/**
 * Short-lived bearer tokens, so a passcode never has to be stored in the browser.
 *
 * Signed with a dedicated high-entropy secret, NOT with the passcode. Deriving the key
 * from the passcode looks tidy and is a trap: a token is `role.exp.signature` with the
 * first two parts known, so anyone holding a stolen token could brute force a
 * human-chosen passcode offline. Since the whole point of tokens here is that browser
 * storage is shared with every other project on the `*.github.io` origin, a stolen token
 * is exactly the case being designed for.
 *
 * Rotating TOKEN_SECRET invalidates every token at once. Rotating a passcode no longer
 * does, so revoking access means rotating both.
 */

export type Role = 'photographer' | 'manager';

const ENC = new TextEncoder();
const TOKEN_TTL_SEC = 16 * 60 * 60; // one evening, plus the morning after

// Deriving one key per role means a photographer signature can never be replayed as a
// manager one even if the role check were somehow skipped.
async function keyFor(secret: string, role: Role): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', ENC.encode(secret), 'HKDF', false, [
    'deriveBits'
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ENC.encode('eventlens-token-v1'),
      info: ENC.encode(`role:${role}`)
    },
    material,
    256
  );
  return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify'
  ]);
}

const b64url = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export interface Issued {
  token: string;
  expiresAt: number; // epoch seconds
}

export async function issueToken(role: Role, secret: string, nowSec: number): Promise<Issued> {
  const expiresAt = nowSec + TOKEN_TTL_SEC;
  const body = `${role}.${expiresAt}`;
  const sig = await crypto.subtle.sign('HMAC', await keyFor(secret, role), ENC.encode(body));
  return { token: `v1.${body}.${b64url(sig)}`, expiresAt };
}

/**
 * Returns the role a token proves, or null. `crypto.subtle.verify` is constant time, so an
 * attacker learns nothing from how long a rejection takes.
 */
export async function verifyToken(
  token: string,
  secret: string,
  nowSec: number
): Promise<Role | null> {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, role, expStr, sigB64] = parts;
  if (role !== 'photographer' && role !== 'manager') return null;

  const exp = Number(expStr);
  if (!Number.isSafeInteger(exp) || exp <= nowSec) return null;
  if (!secret) return null;

  // Restore the padding and URL-safe substitutions that b64url stripped.
  const b64 = sigB64.replace(/-/g, '+').replace(/_/g, '/');
  // Explicitly ArrayBuffer-backed: the default `Uint8Array` is `ArrayBufferLike`, which
  // could be a SharedArrayBuffer and so does not satisfy BufferSource.
  let sig: Uint8Array<ArrayBuffer>;
  try {
    const raw = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    // Allocated rather than `Uint8Array.from`, so the buffer type is a plain ArrayBuffer
    // and satisfies BufferSource without a cast.
    sig = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) sig[i] = raw.charCodeAt(i);
  } catch {
    return null;
  }

  const ok = await crypto.subtle.verify(
    'HMAC',
    await keyFor(secret, role),
    sig,
    ENC.encode(`${role}.${exp}`)
  );
  return ok ? role : null;
}

/**
 * Compares two secrets without leaking their contents through timing. Length is compared
 * first and unavoidably leaks, which is why both sides are hashed to a fixed size first.
 */
export async function secretEquals(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', ENC.encode(a)),
    crypto.subtle.digest('SHA-256', ENC.encode(b))
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}
