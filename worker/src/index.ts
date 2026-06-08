import { AwsClient } from 'aws4fetch';

interface Env {
  DB: D1Database;
  PASSCODE: string;
  MANAGER_PASSCODE: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  PUBLIC_BASE: string;
  ALLOWED_ORIGIN: string; // exact deployed app origin, e.g. https://user.github.io
}

function cors(env: Env) {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-passcode, x-manager-passcode',
    'vary': 'origin'
  };
}

const json = (o: unknown, env: Env, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(env) } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    const url = new URL(req.url);
    const isPhotographer = req.headers.get('x-passcode') === env.PASSCODE;
    const isManager = req.headers.get('x-manager-passcode') === env.MANAGER_PASSCODE;

    // /sign — photographer only. Validate, record a pending row (server owns key+public_url), return signed PUT URL.
    if (url.pathname === '/sign' && req.method === 'POST') {
      if (!isPhotographer) return json({ error: 'unauthorized' }, env, 401);
      const { id, eventDate, originalName } = await req.json<{ id: string; eventDate: string; originalName?: string }>();
      if (!/^[\w-]{8,}$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return json({ error: 'bad input' }, env, 400);

      const key = `events/${eventDate}/${id}.avif`;
      const publicUrl = `${env.PUBLIC_BASE}/${key}`;

      const insertRes = await env.DB.prepare(
        `INSERT OR IGNORE INTO photos (id, r2_key, public_url, event_date, original_name, status)
         VALUES (?,?,?,?,?,'pending')`
      ).bind(id, key, publicUrl, eventDate, originalName ?? null).run();

      if ((insertRes.meta.changes ?? 0) === 0) {
        const existing = await env.DB.prepare(`SELECT status FROM photos WHERE id = ?`)
          .bind(id).first<{ status: string }>();
        if (existing?.status === 'confirmed') return json({ error: 'already confirmed' }, env, 409);
      }

      const target = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}`;
      const client = new AwsClient({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        service: 's3',
        region: 'auto'
      });
      const signed = await client.sign(
        new Request(`${target}?X-Amz-Expires=3600`, { method: 'PUT', headers: { 'content-type': 'image/avif' } }),
        { aws: { signQuery: true } }
      );
      return json({ uploadUrl: signed.url, publicUrl, key }, env);
    }

    // /meta — photographer only. Confirm an existing PENDING row; cannot inject key/url/date
    // and cannot overwrite an already-confirmed photo (WHERE ... status='pending').
    if (url.pathname === '/meta' && req.method === 'POST') {
      if (!isPhotographer) return json({ error: 'unauthorized' }, env, 401);
      const m = await req.json<{ id: string; original_name?: string; width: number; height: number; bytes: number }>();
      if (!/^[\w-]{8,}$/.test(m.id)) return json({ error: 'bad input' }, env, 400);
      if (![m.width, m.height, m.bytes].every((n) => Number.isFinite(n) && n > 0)) return json({ error: 'bad input' }, env, 400);
      const res = await env.DB.prepare(
        `UPDATE photos SET width=?, height=?, bytes=?, original_name=COALESCE(?, original_name), status='confirmed'
         WHERE id=? AND status='pending'`
      ).bind(m.width, m.height, m.bytes, m.original_name ?? null, m.id).run();
      if ((res.meta.changes ?? 0) === 0) return json({ error: 'unknown or already-confirmed id' }, env, 404);
      return json({ ok: true }, env);
    }

    // /list — manager only. Confirmed photos for one event date.
    if (url.pathname === '/list' && req.method === 'GET') {
      if (!isManager) return json({ error: 'unauthorized' }, env, 401);
      const date = url.searchParams.get('date') ?? '';
      // Syntactic shape AND a real calendar date (rejects e.g. 9999-99-99).
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return json({ error: 'bad input' }, env, 400);
      const { results } = await env.DB.prepare(
        `SELECT id, public_url, original_name, width, height, bytes, created_at
         FROM photos WHERE event_date = ? AND status = 'confirmed' ORDER BY created_at`
      ).bind(date).all();
      return json({ photos: results ?? [] }, env);
    }

    return json({ error: 'not found' }, env, 404);
  }
};
