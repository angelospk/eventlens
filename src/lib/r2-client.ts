import type { Uploader } from './upload-queue';
import type { QueueItem, Processed, PhotoMeta, SignResult, FetchLike } from './types';
import { AlreadyUploadedError, NetworkError, classifyStatus } from './errors';
import type { AuthHeaders } from './session';
import { detectOutputFormat } from './image-format';

/** Where one photo currently is, so the UI can say more than "working". */
export type Stage = 'preparing' | 'processing' | 'sending' | 'confirming';

export interface R2UploaderDeps {
  workerUrl: string;
  auth: AuthHeaders;
  fetchImpl?: FetchLike;
  process?: (file: Blob, mime: string) => Promise<Processed>;
  onStage?: (id: string, stage: Stage) => void;
}

export function makeR2Uploader(deps: R2UploaderDeps): Uploader {
  const rawFetch = deps.fetchImpl ?? fetch;

  // A fetch that rejects is the browser telling us the request never left, or never got an
  // answer. Naming that case explicitly is what lets the queue keep retrying it and the UI
  // explain it, instead of showing the photographer a TypeError.
  const f: FetchLike = async (url, init) => {
    try {
      return await rawFetch(url, init);
    } catch {
      throw new NetworkError(String(url).replace(/\?.*/, ''));
    }
  };

  const stage = (id: string, s: Stage) => deps.onStage?.(id, s);
  // Lazy import keeps the browser-only processor (and its `$app/paths` import)
  // out of non-browser test loads. Tests inject `process`, so this never runs there.
  const proc =
    deps.process ??
    ((file: Blob, mime: string) => import('./processor').then((m) => m.processImage(file, mime)));

  return {
    async run(item: QueueItem) {
      // Resolved per attempt rather than captured once: a retry hours later must not send
      // a token that expired while the photo sat in the queue.
      stage(item.id, 'preparing');
      const auth = await deps.auth();

      // 1) Sign FIRST: validates the credentials before expensive AVIF work, and the
      //    Worker records a pending row keyed by id (server owns key/public_url).
      // The server builds the object key and signs an exact content type, so it has to be
      // told the format up front. Probed once per session rather than derived from the
      // encoder afterwards, which keeps signing first: a photo the server already has is
      // rejected before any pixels are touched.
      const fmt = await detectOutputFormat();

      stage(item.id, 'preparing');
      const signRes = await f(`${deps.workerUrl}/sign`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: item.id,
          eventDate: item.eventDate,
          originalName: item.originalName,
          ext: fmt.ext
        })
      });
      if (signRes.status === 409) {
        // The server already has this photo confirmed, so a previous attempt got through
        // and only its response was lost. Nothing to redo.
        throw new AlreadyUploadedError(item.id);
      }
      if (!signRes.ok) throw classifyStatus(signRes.status, 'sign') ?? new Error(`sign failed ${signRes.status}`);
      const { uploadUrl, thumbUploadUrl } = (await signRes.json()) as SignResult;

      // 2) Encode with the browser's own encoder. Fast enough that the photographer sees
      //    it as instant, unlike the WebAssembly encoder this replaced.
      stage(item.id, 'processing');
      const out = await proc(item.file, fmt.mime);

      // 3) PUT to R2. content-type MUST match what was signed exactly. Every failure here
      //    is retryable: each attempt re-signs, so even an expired signature self-heals.
      stage(item.id, 'sending');
      const put = await f(uploadUrl, {
        method: 'PUT',
        // Must match what was signed byte for byte, so the signed format wins.
        headers: { 'content-type': fmt.mime },
        body: out.blob
      });
      if (!put.ok) throw new Error(`put failed ${put.status}`);

      // 3b) The gallery-sized copy, if there is one. Deliberately best-effort: the
      //     photograph itself is already safely stored, and losing a thumbnail costs a
      //     visitor some bytes, while failing the whole upload over it would cost the
      //     photograph. The gallery falls back to the full frame when it is missing.
      let hasThumb = false;
      if (out.thumb && thumbUploadUrl) {
        try {
          const putThumb = await f(thumbUploadUrl, {
            method: 'PUT',
            headers: { 'content-type': fmt.mime },
            body: out.thumb
          });
          hasThumb = putThumb.ok;
        } catch {
          hasThumb = false;
        }
      }

      // 4) Confirm metadata. Server already knows key/public_url from /sign;
      //    we only confirm + report dimensions. Idempotent on id.
      const meta: PhotoMeta = {
        id: item.id, original_name: item.originalName,
        width: out.width, height: out.height, bytes: out.bytes,
        hasThumb
      };
      stage(item.id, 'confirming');
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
