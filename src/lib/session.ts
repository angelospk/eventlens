import { requestToken, type Role, type TokenGrant } from './auth-client';
import type { FetchLike } from './types';

/**
 * Holds credentials for one signed-in user.
 *
 * The passcode is never written to storage. GitHub Pages project sites all share the
 * `*.github.io` origin and web storage is scoped to the origin, not to /eventlens/, so
 * anything persisted there is readable by every other project on the account. What gets
 * persisted instead is a short-lived token: it expires on its own, it reveals nothing
 * about the passcode, and rotating TOKEN_SECRET on the Worker invalidates every token
 * already issued.
 */

const KEY = (role: Role) => `eventlens.${role}.token.v2`;

// Renew slightly early so a request is never sent with a token that expires in flight.
const SKEW_SEC = 120;

const now = () => Math.floor(Date.now() / 1000);

// Feature-detected rather than imported from $app/environment, so this module carries no
// SvelteKit dependency and its credential logic can be unit tested directly.
const hasStorage = () => typeof localStorage !== 'undefined' && typeof sessionStorage !== 'undefined';

// Storage access throws outright in Safari private browsing and when a quota is
// exhausted. A token that cannot be remembered is a re-login; an exception here would
// happen during startup and take the whole app down with it.
function safeGet(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(store: Storage, key: string, value: string) {
  try {
    store.setItem(key, value);
  } catch {
    // not remembered; the user signs in again next time
  }
}

function safeRemove(store: Storage, key: string) {
  try {
    store.removeItem(key);
  } catch {
    // nothing to do
  }
}

export class Session {
  // In memory only, and only for the current tab: used to mint a fresh token when the
  // photographer signed in offline, or when a long night outlives the first one.
  private passcode: string | null = null;
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<TokenGrant | null> | null = null;
  // Bumped on sign-out. A token request started before the user signed out must not write
  // its result afterwards, which would silently sign them back in.
  private epoch = 0;
  // Which role the in-memory passcode belongs to, so an offline sign-in sends it in the
  // right header once the network comes back.
  private heldPasscodeRole: Role | null = null;

  /**
   * Which role's token is actually being held. Usually the page's own role, but the upload
   * page happily runs on a manager's token.
   */
  private held: Role;

  /**
   * The manager can delete photos, so their token dies with the tab. The photographer's
   * survives a reload, which is what keeps a dropped phone from interrupting the night.
   */
  /**
   * Both roles persist, so neither passcode has to be typed again after the app is closed.
   * The manager's used to live in sessionStorage, which on a phone means retyping it every
   * single time the app is reopened — during an event that is many times a night, on a
   * screen the manager is switching to and from constantly.
   *
   * What is stored is a short-lived token, never the passcode, and the origin is shared
   * with the account's other GitHub Pages projects: the exposure is a token that expires
   * on its own and that rotating TOKEN_SECRET revokes.
   */
  private storeFor(_role: Role): Storage | null {
    if (!hasStorage()) return null;
    return localStorage;
  }

  constructor(
    private workerUrl: string,
    public readonly role: Role,
    private fetchImpl?: FetchLike,
    /**
     * Other roles whose token this page will happily run on. The upload page accepts a
     * manager's, so someone who has already signed in to moderate can cross over to
     * uploading without being asked for a second passcode.
     */
    private readonly alsoAccept: Role[] = []
  ) {
    this.held = role;
  }

  /** Picks up a token left by a previous page load. Returns true if one is still valid. */
  restore(): boolean {
    for (const role of [this.role, ...this.alsoAccept]) {
      const store = this.storeFor(role);
      if (!store) continue;
      const raw = safeGet(store, KEY(role));
      if (!raw) continue;
      try {
        const { token, expiresAt } = JSON.parse(raw) as { token: string; expiresAt: number };
        if (!token || expiresAt <= now()) {
          safeRemove(store, KEY(role));
          continue;
        }
        this.token = token;
        this.expiresAt = expiresAt;
        this.held = role;
        return true;
      } catch {
        safeRemove(store, KEY(role));
      }
    }
    return false;
  }

  private keep(grant: TokenGrant, role: Role) {
    this.token = grant.token;
    this.expiresAt = grant.expiresAt;
    this.held = role;
    const store = this.storeFor(role);
    if (store) {
      safeSet(store, KEY(role), JSON.stringify({ token: grant.token, expiresAt: grant.expiresAt }));
    }
  }

  /**
   * 'ok'      the passcode is right and a token is held
   * 'bad'     the server rejected it
   * 'offline' the server could not be reached; the passcode is kept in memory and a token
   *           is minted on the first request that gets through
   */
  async signIn(passcode: string): Promise<'ok' | 'bad' | 'offline'> {
    const epoch = this.epoch;
    try {
      // Tried as this page's own role first, then as any role it also accepts, so the
      // manager's passcode works on the upload screen without a second credential.
      for (const role of [this.role, ...this.alsoAccept]) {
        const grant = await requestToken(
          { workerUrl: this.workerUrl, fetchImpl: this.fetchImpl },
          passcode,
          role
        );
        if (epoch !== this.epoch) return 'bad'; // signed out while this was in flight
        if (grant) {
          this.passcode = passcode;
          this.heldPasscodeRole = role;
          this.keep(grant, role);
          return 'ok';
        }
      }
      return 'bad';
    } catch {
      if (epoch !== this.epoch) return 'bad';
      this.passcode = passcode;
      return 'offline';
    }
  }

  /** True once there is something to authenticate with, token or passcode. */
  get authenticated(): boolean {
    return Boolean(this.token || this.passcode);
  }

  /** True once the server has actually confirmed the passcode by issuing a token. */
  get verified(): boolean {
    return this.token !== null;
  }

  /**
   * Auth headers for one request, refreshing the token when it is close to expiry. Falls
   * back to the raw passcode header only while no token could be obtained, which is the
   * offline-sign-in case.
   */
  async headers(): Promise<Record<string, string>> {
    if (this.token && this.expiresAt - SKEW_SEC > now()) {
      return { authorization: `Bearer ${this.token}` };
    }

    if (this.passcode) {
      const epoch = this.epoch;
      // One mint at a time: a queue draining ten photos must not fire ten /auth calls.
      const role = this.heldPasscodeRole ?? this.role;
      this.inflight ??= requestToken(
        { workerUrl: this.workerUrl, fetchImpl: this.fetchImpl },
        this.passcode,
        role
      ).finally(() => {
        this.inflight = null;
      });
      try {
        const grant = await this.inflight;
        if (epoch !== this.epoch) return {}; // signed out mid-flight; send nothing
        if (grant) {
          this.keep(grant, role);
          return { authorization: `Bearer ${this.token}` };
        }
        // Rejected: fall through and let the passcode produce a clean 401 downstream, so
        // the upload queue classifies it as non-retryable instead of looping.
      } catch {
        // Unreachable: the passcode header below still works once connectivity returns.
      }
      if (epoch !== this.epoch || !this.passcode) return {};
      const header = role === 'manager' ? 'x-manager-passcode' : 'x-passcode';
      return { [header]: this.passcode };
    }

    // Expired token and no passcode: send it anyway and let the 401 drive a re-login.
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  /** True when this page is running on a token issued for a different, broader role. */
  get borrowedRole(): Role | null {
    return this.held === this.role ? null : this.held;
  }

  signOut() {
    this.epoch++;
    this.inflight = null;
    this.passcode = null;
    this.heldPasscodeRole = null;
    this.held = this.role;
    this.token = null;
    this.expiresAt = 0;
    const own = this.storeFor(this.role);
    if (own) safeRemove(own, KEY(this.role));
    // A token for the other role may be sitting in the other storage from an earlier
    // session on this device; clear both so "sign out" means it.
    if (hasStorage()) {
      // Both keys from both stores: the manager's token used to live in sessionStorage,
      // so a device that has been through the change can hold one in either place.
      for (const store of [localStorage, sessionStorage]) {
        safeRemove(store, KEY('photographer'));
        safeRemove(store, KEY('manager'));
      }
      // Remove the pre-token key too, so an upgrade does not leave a passcode behind.
      safeRemove(localStorage, 'eventlens.photographer.v1');
      safeRemove(sessionStorage, 'eventlens.manager.v1');
    }
  }
}

/** Auth headers for one request. Everything that talks to the Worker takes one of these. */
export type AuthHeaders = () => Promise<Record<string, string>>;
