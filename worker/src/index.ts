import { AwsClient } from 'aws4fetch';

interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  PASSCODE: string;
  MANAGER_PASSCODE: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  PUBLIC_BASE: string;
  ALLOWED_ORIGIN: string; // exact deployed app origin, e.g. https://user.github.io
}

// Public reads are served from the Cloudflare edge cache so a room full of guests
// polling the live page costs a handful of D1 queries, not one per viewer.
const PUBLIC_CACHE = 'public, max-age=5, s-maxage=15, stale-while-revalidate=60';

const ID_RE = /^[\w-]{8,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 4096;

function cors(env: Env) {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-passcode, x-manager-passcode',
    vary: 'origin'
  };
}

const json = (o: unknown, env: Env, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(o), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': cache, ...cors(env) }
  });

// Generic on purpose: never tell a caller *which* passcode was wrong.
const unauthorized = (env: Env) => json({ error: 'unauthorized' }, env, 401);
const badInput = (env: Env, code = 'bad_input') => json({ error: code }, env, 400);

/** A real calendar date in YYYY-MM-DD (round-trip rejects e.g. 2026-02-31). */
function validDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/** Reads a JSON body with a hard size cap so a huge POST can't be used to burn CPU. */
async function readJson<T>(req: Request): Promise<T | null> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > MAX_BODY) return null;
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    const url = new URL(req.url);
    const isPhotographer = req.headers.get('x-passcode') === env.PASSCODE;
    const isManager = req.headers.get('x-manager-passcode') === env.MANAGER_PASSCODE;

    // The cached /wall payload for one night. Normalised so ?date=X&anything-else cannot
    // fragment the cache, and shared by the read path and every write that invalidates it.
    const wallKey = (date: string) => new Request(`${url.origin}/wall?date=${date}`, { method: 'GET' });

    /**
     * Drops the cached public payload for a night. Without this, hiding or deleting a photo
     * leaves it on the projector for up to the stale-while-revalidate window: the manager
     * clicks "hide" and watches the photo stay up for another minute.
     */
    const purgeWall = (date: string) => ctx.waitUntil(caches.default.delete(wallKey(date)));

    // --- GET /auth — verify a passcode before the user starts shooting, so a typo is
    // caught here instead of failing every upload in the queue eight times over.
    if (url.pathname === '/auth' && req.method === 'GET') {
      if (isManager) return json({ role: 'manager' }, env);
      if (isPhotographer) return json({ role: 'photographer' }, env);
      return unauthorized(env);
    }

    // --- POST /sign — photographer only. Records a pending row (the server owns key and
    // public_url) and returns a signed PUT URL.
    if (url.pathname === '/sign' && req.method === 'POST') {
      if (!isPhotographer) return unauthorized(env);
      const body = await readJson<{ id: string; eventDate: string; originalName?: string }>(req);
      if (!body) return badInput(env);
      const { id, eventDate, originalName } = body;
      if (!ID_RE.test(id) || !validDate(eventDate)) return badInput(env);

      const key = `events/${eventDate}/${id}.avif`;
      const publicUrl = `${env.PUBLIC_BASE}/${key}`;

      const insertRes = await env.DB.prepare(
        `INSERT OR IGNORE INTO photos (id, r2_key, public_url, event_date, original_name, status)
         VALUES (?,?,?,?,?,'pending')`
      )
        .bind(id, key, publicUrl, eventDate, originalName ?? null)
        .run();

      if ((insertRes.meta.changes ?? 0) === 0) {
        const existing = await env.DB.prepare(`SELECT status FROM photos WHERE id = ?`)
          .bind(id)
          .first<{ status: string }>();
        // Already confirmed means a previous attempt actually succeeded and only the
        // response was lost. The client treats this as success, not as an error.
        if (existing?.status === 'confirmed') {
          return json({ error: 'already_confirmed', publicUrl, key }, env, 409);
        }
      }

      const target = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}`;
      const client = new AwsClient({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        service: 's3',
        region: 'auto'
      });
      const signed = await client.sign(
        new Request(`${target}?X-Amz-Expires=3600`, {
          method: 'PUT',
          headers: { 'content-type': 'image/avif' }
        }),
        { aws: { signQuery: true } }
      );
      return json({ uploadUrl: signed.url, publicUrl, key }, env);
    }

    // --- POST /meta — photographer only. Confirms a pending row. Moderation state is
    // decided here by the night's auto-approve switch, so the client cannot publish itself.
    if (url.pathname === '/meta' && req.method === 'POST') {
      if (!isPhotographer) return unauthorized(env);
      const m = await readJson<{
        id: string;
        original_name?: string;
        width: number;
        height: number;
        bytes: number;
      }>(req);
      if (!m) return badInput(env);
      if (!ID_RE.test(m.id)) return badInput(env);
      if (![m.width, m.height, m.bytes].every((n) => Number.isFinite(n) && n > 0)) {
        return badInput(env);
      }

      const row = await env.DB.prepare(
        `SELECT event_date FROM photos WHERE id = ? AND status = 'pending'`
      )
        .bind(m.id)
        .first<{ event_date: string }>();
      if (!row) return json({ error: 'unknown_or_confirmed' }, env, 404);

      const ev = await env.DB.prepare(`SELECT auto_approve FROM events WHERE event_date = ?`)
        .bind(row.event_date)
        .first<{ auto_approve: number }>();
      const moderation = ev?.auto_approve ? 'approved' : 'pending';

      const res = await env.DB.prepare(
        `UPDATE photos
         SET width=?, height=?, bytes=?, original_name=COALESCE(?, original_name),
             status='confirmed', moderation=?
         WHERE id=? AND status='pending'`
      )
        .bind(m.width, m.height, m.bytes, m.original_name ?? null, moderation, m.id)
        .run();
      if ((res.meta.changes ?? 0) === 0) return json({ error: 'unknown_or_confirmed' }, env, 404);
      // Only when the photo actually went public: during a reviewed night nothing changed
      // for the audience, so the cache is left alone.
      if (moderation === 'approved') purgeWall(row.event_date);
      return json({ ok: true, moderation }, env);
    }

    // --- GET /wall — public. Approved photos for one night, edge-cached. This is the read
    // path for both the projector wall and the shareable live page, so it has to stay cheap
    // with a few hundred concurrent viewers.
    if (url.pathname === '/wall' && req.method === 'GET') {
      const date = url.searchParams.get('date') ?? '';
      if (!validDate(date)) return badInput(env);

      const cacheKey = wallKey(date);
      const cache = caches.default;
      const hit = await cache.match(cacheKey);
      if (hit) return hit;

      const [{ results }, ev] = await Promise.all([
        // public_url is derived from PUBLIC_BASE at read time rather than read from the
        // stored column, so moving the bucket to a custom domain instantly fixes up every
        // past photo instead of only newly uploaded ones.
        env.DB.prepare(
          `SELECT id, r2_key, created_at
           FROM photos
           WHERE event_date = ? AND status = 'confirmed' AND moderation = 'approved'
           ORDER BY created_at`
        )
          .bind(date)
          .all<{ id: string; r2_key: string; created_at: string }>(),
        env.DB.prepare(`SELECT title FROM events WHERE event_date = ?`)
          .bind(date)
          .first<{ title: string | null }>()
      ]);

      const photos = (results ?? []).map((p) => ({
        id: p.id,
        public_url: `${env.PUBLIC_BASE}/${p.r2_key}`,
        created_at: p.created_at
      }));

      const res = json({ date, title: ev?.title ?? null, photos }, env, 200, PUBLIC_CACHE);
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    // --- GET /list — manager only. Everything for the night, including photos still
    // awaiting review, so the manager can actually moderate.
    if (url.pathname === '/list' && req.method === 'GET') {
      if (!isManager) return unauthorized(env);
      const date = url.searchParams.get('date') ?? '';
      if (!validDate(date)) return badInput(env);
      const { results } = await env.DB.prepare(
        `SELECT id, r2_key, original_name, width, height, bytes, created_at, moderation
         FROM photos
         WHERE event_date = ? AND status = 'confirmed' AND moderation != 'deleting'
         ORDER BY created_at`
      )
        .bind(date)
        .all<{ id: string; r2_key: string; [k: string]: unknown }>();
      const ev = await env.DB.prepare(`SELECT title, auto_approve FROM events WHERE event_date = ?`)
        .bind(date)
        .first<{ title: string | null; auto_approve: number }>();
      return json(
        {
          photos: (results ?? []).map(({ r2_key, ...p }) => ({
            ...p,
            public_url: `${env.PUBLIC_BASE}/${r2_key}`
          })),
          event: { date, title: ev?.title ?? null, autoApprove: Boolean(ev?.auto_approve) }
        },
        env
      );
    }

    // --- POST /moderate — manager only. approve | hide | pending for one photo, or for every
    // reviewable photo of a night when `all` is set (the "approve everything" button).
    if (url.pathname === '/moderate' && req.method === 'POST') {
      if (!isManager) return unauthorized(env);
      const body = await readJson<{ id?: string; date?: string; all?: boolean; action: string }>(req);
      if (!body) return badInput(env);
      const { action } = body;
      if (!['approve', 'hide', 'pending'].includes(action)) return badInput(env);
      const next = action === 'approve' ? 'approved' : action === 'hide' ? 'hidden' : 'pending';

      if (body.all) {
        if (!body.date || !validDate(body.date)) return badInput(env);
        const res = await env.DB.prepare(
          `UPDATE photos SET moderation=?
           WHERE event_date=? AND status='confirmed' AND moderation NOT IN ('deleting', ?)`
        )
          .bind(next, body.date, next)
          .run();
        purgeWall(body.date);
        return json({ ok: true, changed: res.meta.changes ?? 0 }, env);
      }

      if (!body.id || !ID_RE.test(body.id)) return badInput(env);
      // event_date comes back from the update so the right night's cache can be dropped.
      const res = await env.DB.prepare(
        `UPDATE photos SET moderation=? WHERE id=? AND status='confirmed' AND moderation != 'deleting'
         RETURNING event_date`
      )
        .bind(next, body.id)
        .first<{ event_date: string }>();
      if (!res) return json({ error: 'not_found' }, env, 404);
      purgeWall(res.event_date);
      return json({ ok: true, moderation: next }, env);
    }

    // --- POST /delete — manager only. R2 and D1 cannot be deleted atomically, so the row is
    // tombstoned first: a half-finished delete leaves the photo invisible and retryable,
    // never visible-but-broken.
    if (url.pathname === '/delete' && req.method === 'POST') {
      if (!isManager) return unauthorized(env);
      const body = await readJson<{ id: string }>(req);
      if (!body || !ID_RE.test(body.id ?? '')) return badInput(env);

      const row = await env.DB.prepare(`SELECT r2_key, event_date FROM photos WHERE id = ?`)
        .bind(body.id)
        .first<{ r2_key: string; event_date: string }>();
      if (!row) return json({ error: 'not_found' }, env, 404);

      await env.DB.prepare(`UPDATE photos SET moderation='deleting' WHERE id=?`).bind(body.id).run();
      // Pull it off the public page immediately, before the slower object delete.
      purgeWall(row.event_date);
      try {
        await env.BUCKET.delete(row.r2_key);
      } catch {
        // Object still there: the row stays 'deleting' (invisible everywhere) and a repeat
        // call retries the object delete.
        return json({ error: 'storage_delete_failed' }, env, 502);
      }
      await env.DB.prepare(`DELETE FROM photos WHERE id=?`).bind(body.id).run();
      return json({ ok: true }, env);
    }

    // --- /event — manager only. The per-night auto-approve switch and the title.
    if (url.pathname === '/event' && req.method === 'GET') {
      if (!isManager) return unauthorized(env);
      const date = url.searchParams.get('date') ?? '';
      if (!validDate(date)) return badInput(env);
      const ev = await env.DB.prepare(`SELECT title, auto_approve FROM events WHERE event_date = ?`)
        .bind(date)
        .first<{ title: string | null; auto_approve: number }>();
      return json({ date, title: ev?.title ?? null, autoApprove: Boolean(ev?.auto_approve) }, env);
    }

    if (url.pathname === '/event' && req.method === 'POST') {
      if (!isManager) return unauthorized(env);
      const body = await readJson<{ date: string; title?: string; autoApprove?: boolean }>(req);
      if (!body || !validDate(body.date ?? '')) return badInput(env);
      const title = typeof body.title === 'string' ? body.title.slice(0, 120) : null;
      // An omitted autoApprove means "leave it alone". Treating it as false would let a
      // title-only save silently switch a night back to manual review.
      const autoApprove = typeof body.autoApprove === 'boolean' ? (body.autoApprove ? 1 : 0) : null;
      await env.DB.prepare(
        `INSERT INTO events (event_date, title, auto_approve) VALUES (?,?,COALESCE(?,0))
         ON CONFLICT(event_date) DO UPDATE SET
           title = COALESCE(excluded.title, events.title),
           auto_approve = COALESCE(?, events.auto_approve)`
      )
        .bind(body.date, title, autoApprove, autoApprove)
        .run();
      purgeWall(body.date); // the night's title is part of the cached public payload
      return json({ ok: true }, env);
    }

    return json({ error: 'not_found' }, env, 404);
  }
};
