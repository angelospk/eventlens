import type { Uploader } from './upload-queue';
import type { QueueItem, Processed, PhotoMeta, SignResult, FetchLike } from './types';
import { AlreadyUploadedError, classifyStatus } from './errors';
import type { AuthHeaders } from './session';

export interface R2UploaderDeps {
  workerUrl: string;
  auth: AuthHeaders;
  fetchImpl?: FetchLike;
  process?: (file: Blob) => Promise<Processed>;
}

export function makeR2Uploader(deps: R2UploaderDeps): Uploader {
  const f = deps.fetchImpl ?? fetch;
  // Lazy import keeps the browser-only processor (and its `$app/paths` import)
  // out of non-browser test loads. Tests inject `process`, so this never runs there.
  const proc = deps.process ?? ((file: Blob) => import('./processor').then((m) => m.processImage(file)));

  return {
    async run(item: QueueItem) {
      // Resolved per attempt rather than captured once: a retry hours later must not send
      // a token that expired while the photo sat in the queue.
      const auth = await deps.auth();

      // 1) Sign FIRST: validates the credentials before expensive AVIF work, and the
      //    Worker records a pending row keyed by id (server owns key/public_url).
      const signRes = await f(`${deps.workerUrl}/sign`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id, eventDate: item.eventDate, originalName: item.originalName })
      });
      if (signRes.status === 409) {
        // The server already has this photo confirmed, so a previous attempt got through
        // and only its response was lost. Nothing to redo.
        throw new AlreadyUploadedError(item.id);
      }
      if (!signRes.ok) throw classifyStatus(signRes.status, 'sign') ?? new Error(`sign failed ${signRes.status}`);
      const { uploadUrl } = (await signRes.json()) as SignResult;

      // 2) Process (grade + logo + AVIF) off the main thread.
      const out = await proc(item.file);

      // 3) PUT to R2. content-type MUST match what was signed exactly. Every failure here
      //    is retryable: each attempt re-signs, so even an expired signature self-heals.
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
      // 404 here means the row is no longer pending — i.e. something already confirmed it.
      // The bytes are in R2 and the row is confirmed, so this is a success too.
      if (metaRes.status === 404) throw new AlreadyUploadedError(item.id);
      if (!metaRes.ok) throw classifyStatus(metaRes.status, 'meta') ?? new Error(`meta failed ${metaRes.status}`);
    }
  };
}
