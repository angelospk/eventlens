import type { Uploader } from './upload-queue';
import type { QueueItem, Processed, PhotoMeta, SignResult, FetchLike } from './types';
import { log } from './log';
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

/**
 * How long a single request may hang before it is treated as failed.
 *
 * Without these, a request on a flaky radio simply never settles: the photograph sits at
 * "uploading" forever, the queue waits behind it, and nothing in the interface is wrong
 * enough to explain why. Aborting turns a hang into an ordinary retry, which the queue
 * already knows how to survive.
 *
 * The upload of the photograph itself gets far longer than the small JSON calls, because
 * it is the only one carrying real bytes over the venue's connection.
 */
const CALL_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 90_000;
/** Five minutes for one photograph is absurd on a good link and right on a terrible one. */
const MAX_UPLOAD_TIMEOUT_MS = 300_000;

/**
 * The last photograph encoded, kept so a retry does not redo the work. One entry only: the
 * queue uploads one at a time, so the retry that matters is always of the same photograph,
 * and holding more would mean holding a night's worth of decoded images in memory.
 */
let encoded: { id: string; mime: string; out: Processed } | null = null;

/**
 * A signal that fires on the timeout OR when the photographer abandons the photograph.
 * `AbortSignal.timeout` and `AbortSignal.any` are both missing from older Safari, so the
 * two are combined by hand.
 */
function deadline(ms: number, external?: AbortSignal): AbortSignal {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(new Error('timeout')), ms);
  const stop = () => {
    clearTimeout(timer);
    c.abort(external?.reason ?? new Error('cancelled'));
  };
  if (external) {
    if (external.aborted) stop();
    else external.addEventListener('abort', stop, { once: true });
  }
  // Once the request settles the timer is irrelevant; letting it run would abort a
  // controller nobody is listening to, which is harmless but noisy in a profiler.
  c.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return c.signal;
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
    async run(item: QueueItem, signal?: AbortSignal) {
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
      // Timings are the whole point of the record: "it failed" and "it failed after 90
      // seconds on the PUT" call for completely different fixes.
      const began = Date.now();
      const since = () => `${Date.now() - began}ms`;
      const short = item.id.slice(0, 8);
      log('up', `${short} ${item.originalName} start fmt=${fmt.ext} src=${item.file.size}B`);

      stage(item.id, 'preparing');
      const signRes = await f(`${deps.workerUrl}/sign`, {
        method: 'POST',
        signal: deadline(CALL_TIMEOUT_MS, signal),
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: item.id,
          eventDate: item.eventDate,
          originalName: item.originalName,
          ext: fmt.ext
        })
      });
      log('up', `${short} sign ${signRes.status} ${since()}`);
      if (signRes.status === 409) {
        // The server already has this photo confirmed, so a previous attempt got through
        // and only its response was lost. Nothing to redo.
        throw new AlreadyUploadedError(item.id);
      }
      if (!signRes.ok) throw classifyStatus(signRes.status, 'sign') ?? new Error(`sign failed ${signRes.status}`);
      const { uploadUrl, thumbUploadUrl, key } = (await signRes.json()) as SignResult;

      // 2) Encode with the browser's own encoder. Fast enough that the photographer sees
      //    it as instant, unlike the WebAssembly encoder this replaced.
      stage(item.id, 'processing');
      // Reused when the previous attempt on this same photograph got as far as encoding.
      // A photograph that keeps timing out on the upload was otherwise decoded and
      // re-encoded from scratch on every single lap — minutes of a phone's CPU, and on a
      // large burst the memory pressure that kills the tab.
      let out: Processed;
      if (encoded && encoded.id === item.id && encoded.mime === fmt.mime) {
        out = encoded.out;
        log('up', `${short} reusing the encode from the last try`);
      } else {
        out = await proc(item.file, fmt.mime);
        encoded = { id: item.id, mime: fmt.mime, out };
        log('up', `${short} encoded ${out.width}x${out.height} ${out.bytes}B thumb=${out.thumb?.size ?? 0}B ${since()}`);
      }

      // 3) PUT to R2. content-type MUST match what was signed exactly. Every failure here
      //    is retryable: each attempt re-signs, so even an expired signature self-heals.
      stage(item.id, 'sending');
      // The allowance grows with each try. A fixed ninety seconds is generous on a good
      // connection and simply unreachable on a field full of people: the upload aborts, the
      // abort counts as a network failure, and the photograph loops forever without ever
      // being given long enough to finish.
      const allowance = Math.min(MAX_UPLOAD_TIMEOUT_MS, UPLOAD_TIMEOUT_MS * (item.tries ?? 1));
      const put = await f(uploadUrl, {
        method: 'PUT',
        signal: deadline(allowance, signal),
        // Must match what was signed byte for byte, so the signed format wins.
        headers: { 'content-type': fmt.mime },
        body: out.blob
      });
      log('up', `${short} put ${put.status} ${since()} (allowed ${Math.round(allowance / 1000)}s)`);
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
            signal: deadline(CALL_TIMEOUT_MS, signal),
            headers: { 'content-type': fmt.mime },
            body: out.thumb
          });
          hasThumb = putThumb.ok;
          if (!hasThumb) log('up', `${short} thumb put ${putThumb.status}`);
        } catch (e) {
          hasThumb = false;
          log('up', `${short} thumb failed: ${e instanceof Error ? e.message : e}`);
        }
      }

      // 4) Confirm metadata. The key goes back with it so the server confirms the object
      //    these bytes actually went to: a retry under a different format re-signs the row,
      //    and confirming whatever the row last said would publish a URL pointing at
      //    nothing. Idempotent on id.
      const meta: PhotoMeta = {
        id: item.id, original_name: item.originalName,
        width: out.width, height: out.height, bytes: out.bytes,
        hasThumb, key
      };
      stage(item.id, 'confirming');
      const metaRes = await f(`${deps.workerUrl}/meta`, {
        method: 'POST',
        signal: deadline(CALL_TIMEOUT_MS, signal),
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(meta)
      });
      // 404 here means the row is no longer pending — i.e. something already confirmed it.
      // The bytes are in R2 and the row is confirmed, so this is a success too.
      log('up', `${short} meta ${metaRes.status} total=${since()}`);
      if (encoded?.id === item.id) encoded = null; // done with it; let the bytes go
      if (metaRes.status === 404) throw new AlreadyUploadedError(item.id);
      if (!metaRes.ok) throw classifyStatus(metaRes.status, 'meta') ?? new Error(`meta failed ${metaRes.status}`);
    }
  };
}
