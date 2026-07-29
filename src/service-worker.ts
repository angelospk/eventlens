/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
import { base, build, files, prerendered, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

// Cache names are prefixed because Cache Storage is shared across the whole
// *.github.io origin — a blanket "delete every cache" would wipe out other projects.
const PREFIX = 'eventlens';
const CACHE = `${PREFIX}-${version}`;

// Hashed build output plus everything in static/. These are real files at real URLs, so a
// failure here means something is genuinely broken and the install should fail loudly.
const CORE = [...build, ...files];

// Prerendered routes are best-effort. They are extensionless URLs ("/live") that depend on
// the host rewriting to "live.html"; GitHub Pages does, other static hosts may not. One
// missing page must not take the entire offline mode down with it, which is exactly what
// `addAll` would do since it rejects the whole batch on a single 404.
async function cacheBestEffort(cache: Cache, urls: string[]) {
  await Promise.allSettled(urls.map((url) => cache.add(url)));
}

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(CORE);
      await cacheBestEffort(cache, prerendered);
    })()
  );
});

// Deliberately no skipWaiting/clients.claim. A page that is already open keeps its own
// worker and its own cache generation until it closes. Taking over immediately would let
// activate() delete the caches that the running page still lazy-loads chunks from, so a
// deploy during an event would break the photo processor in an app that looks fine.
sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith(`${PREFIX}-`) && k !== CACHE).map((k) => caches.delete(k))
        )
      )
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
      caches.match(req).then((hit) => hit ?? fetch(req))
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
