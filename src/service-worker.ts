/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
import { base, build, files, prerendered, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

// Cache names are prefixed because Cache Storage is shared across the whole
// *.github.io origin — a blanket "delete every cache" would wipe out other projects.
const PREFIX = 'eventlens';
const CACHE = `${PREFIX}-${version}`;

// A safety net for the HEIC decoder: three megabytes of WebAssembly that only iPhone-native
// files need. SvelteKit does not currently list worker output in `build`, so it is already
// outside the precache and gets stored by the runtime handler the first time it is used.
// This keeps that true if a future version starts listing worker chunks, because precaching
// it would make every install pay for a decoder most nights never touch, on exactly the
// sort of connection where three megabytes decides whether the app is ready at all.
const isOnDemand = (url: string) => url.includes('heic-decoder') || url.includes('/workers/chunks/');

// Hashed build output plus everything in static/. These are real files at real URLs, so a
// failure here means something is genuinely broken and the install should fail loudly.
const CORE = [...build, ...files].filter((url) => !isOnDemand(url));

// Prerendered routes are best-effort. They are extensionless URLs ("/live") that depend on
// the host rewriting to "live.html"; GitHub Pages does, other static hosts may not. One
// missing page must not take the entire offline mode down with it, which is exactly what
// `addAll` would do since it rejects the whole batch on a single 404.
async function cacheBestEffort(cache: Cache, urls: string[]) {
  await Promise.allSettled(urls.map((url) => cache.add(url)));
}

// The page asks for the swap when it judges the moment safe, rather than the worker
// deciding for itself. Without this an installed app on a phone keeps running the old
// code until it is force-quit, which during an event may simply never happen.
sw.addEventListener('message', (event) => {
  if ((event.data as { type?: string })?.type === 'skip-waiting') sw.skipWaiting();
});

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(CORE);
      await cacheBestEffort(cache, prerendered);
    })()
  );
});

// Activation only happens once a page has explicitly asked for it, and that page reloads
// the moment control changes. That ordering is what makes clearing the old caches here
// safe: nothing is still running against them. A worker that took over on its own would
// delete the caches an open page was still lazy-loading its chunks from, and break the
// photo processor in an app that looked perfectly fine.
sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith(`${PREFIX}-`) && k !== CACHE).map((k) => caches.delete(k))
        )
      )
      .then(() => sw.clients.claim())
  );
});

/** Hashed build output never changes under the same URL, so it is safe to serve from cache first. */
const isImmutable = (url: URL) => build.some((asset) => url.pathname === asset);

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Anything not on this origin is left completely alone: the Cloudflare Worker API must
  // stay live (a cached photo list would freeze the wall), and R2 photos would blow the
  // cache quota for no benefit.
  if (url.origin !== sw.location.origin) return;

  // Requests that explicitly opt out of caching (sponsors.json, auth checks).
  if (req.cache === 'no-store') return;

  if (isImmutable(url)) {
    event.respondWith(
      (async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // Not precached, which today means the on-demand HEIC decoder. Store it on the way
        // through: it is content-hashed and therefore never stale, and a photographer who
        // shoots HEIC must not re-download three megabytes for every single photo.
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(CACHE);
          event.waitUntil(cache.put(req, res.clone()));
        }
        return res;
      })()
    );
    return;
  }

  // Everything else — navigations and static assets — prefers the network so the app
  // updates itself, and falls back to the cache when offline.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        // Only successful, non-partial, same-origin responses are worth keeping. The write
        // is handed to waitUntil so the worker cannot be killed mid-put.
        if (res.ok && res.status === 200 && res.type === 'basic') {
          event.waitUntil(cache.put(req, res.clone()));
        }
        return res;
      } catch (err) {
        const hit = await cache.match(req);
        if (hit) return hit;
        // A direct hit on a route we never cached: fall back to the app shell so the SPA
        // can still boot and render that route client-side.
        if (req.mode === 'navigate') {
          const shell = await cache.match(`${base}/`);
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});
