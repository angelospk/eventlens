import { AwsClient } from 'aws4fetch';

interface Env {
  DB: D1Database;
  PASSCODE: string;
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
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-passcode',
    'vary': 'origin'
  };
}

const json = (o: unknown, env: Env, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...cors(env) } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env) });
    if (req.headers.get('x-passcode') !== env.PASSCODE) return json({ error: 'unauthorized' }, env, 401);

    const url = new URL(req.url);

    // /sign — validate, record a pending row (server owns key+public_url), return signed PUT URL.
    if (url.pathname === '/sign' && req.method === 'POST') {
      const { id, eventDate, originalName } = await req.json<{ id: string; eventDate: string; originalName?: string }>();
      if (!/^[\w-]{8,}$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return json({ error: 'bad input' }, env, 400);

      const key = `events/${eventDate}/${id}.avif`;
      const publicUrl = `${env.PUBLIC_BASE}/${key}`;

      // Reserve the row up front. INSERT OR IGNORE so a retried /sign is idempotent.
      const insertRes = await env.DB.prepare(
        `INSERT OR IGNORE INTO photos (id, r2_key, public_url, event_date, original_name, status)
         VALUES (?,?,?,?,?,'pending')`
      ).bind(id, key, publicUrl, eventDate, originalName ?? null).run();

      // If the row already existed and is confirmed, refuse to re-sign (no overwrite of a finished upload).
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

    // /meta — confirm an existing pending row; client cannot inject key/url/date.
    if (url.pathname === '/meta' && req.method === 'POST') {
      const m = await req.json<{ id: string; original_name?: string; width: number; height: number; bytes: number }>();
      if (!/^[\w-]{8,}$/.test(m.id)) return json({ error: 'bad input' }, env, 400);
      if (![m.width, m.height, m.bytes].every((n) => Number.isFinite(n) && n > 0)) return json({ error: 'bad input' }, env, 400);
      const res = await env.DB.prepare(
        `UPDATE photos SET width=?, height=?, bytes=?, original_name=COALESCE(?, original_name), status='confirmed'
         WHERE id=?`
      ).bind(m.width, m.height, m.bytes, m.original_name ?? null, m.id).run();
      if ((res.meta.changes ?? 0) === 0) return json({ error: 'unknown id' }, env, 404);
      return json({ ok: true }, env);
    }

    return json({ error: 'not found' }, env, 404);
  }
};
