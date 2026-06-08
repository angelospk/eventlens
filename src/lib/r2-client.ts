import type { Uploader } from './upload-queue';
import type { QueueItem, Processed, PhotoMeta, SignResult } from './types';

export interface R2UploaderDeps {
  workerUrl: string;
  passcode: string;
  fetchImpl?: typeof fetch;
  process?: (file: Blob) => Promise<Processed>;
}

export function makeR2Uploader(deps: R2UploaderDeps): Uploader {
  const f = deps.fetchImpl ?? fetch;
  // Lazy import keeps the browser-only processor (and its `$app/paths` import)
  // out of non-browser test loads. Tests inject `process`, so this never runs there.
  const proc = deps.process ?? ((file: Blob) => import('./processor').then((m) => m.processImage(file)));
  const auth = { 'x-passcode': deps.passcode };

  return {
    async run(item: QueueItem) {
      // 1) Sign FIRST: validates passcode before expensive AVIF work, and the
      //    Worker records a pending row keyed by id (server owns key/public_url).
      const signRes = await f(`${deps.workerUrl}/sign`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id, eventDate: item.eventDate, originalName: item.originalName })
      });
      if (!signRes.ok) throw new Error(`sign failed ${signRes.status}`);
      const { uploadUrl } = (await signRes.json()) as SignResult;

      // 2) Process (logo + filter + AVIF).
      const out = await proc(item.file);

      // 3) PUT to R2. content-type MUST match what was signed exactly.
      const put = await f(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'image/avif' },
        body: out.avif
      });
      if (!put.ok) throw new Error(`put failed ${put.status}`);

      // 4) Confirm metadata. Server already knows key/public_url from /sign;
      //    we only confirm + report dimensions. Idempotent on id.
      const meta: PhotoMeta = {
        id: item.id, original_name: item.originalName,
        width: out.width, height: out.height, bytes: out.bytes
      };
      const metaRes = await f(`${deps.workerUrl}/meta`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(meta)
      });
      if (!metaRes.ok) throw new Error(`meta failed ${metaRes.status}`);
    }
  };
}
