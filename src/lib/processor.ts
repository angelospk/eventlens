import { base } from '$app/paths';
import { config } from './config';
import { NonRetryableError } from './errors';
import type { Processed } from './types';
import type { ProcessRequest, ProcessResponse } from './processor.worker';

// Main-thread half of the image pipeline. All the heavy work (decode, grade, logo, AVIF
// encode) happens in one long-lived module worker; this file only marshals requests.

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<
  string,
  { resolve: (p: Processed) => void; reject: (e: unknown) => void }
>();

function ensureWorker(): Worker {
  if (worker) return worker;
  // `new URL(..., import.meta.url)` is the form Vite can analyse statically, so the
  // worker chunk is emitted and rewritten to the deployed base path.
  worker = new Worker(new URL('./processor.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<ProcessResponse>) => {
    const res = e.data;
    const entry = pending.get(res.id);
    if (!entry) return;
    pending.delete(res.id);
    if (res.ok) {
      const blob = new Blob([res.buffer], { type: res.mime });
      entry.resolve({ blob, mime: res.mime, width: res.width, height: res.height, bytes: blob.size });
    } else {
      // A processing failure is deterministic: the same file will fail the same way on
      // every retry, so it must not ride the network backoff ladder.
      entry.reject(new NonRetryableError(`Η φωτογραφία δεν μπόρεσε να επεξεργαστεί: ${res.error}`, 'process_failed'));
    }
  };
  worker.onerror = (e) => {
    // The worker itself died: fail everything waiting on it and start fresh next time.
    teardown(new Error(`processor worker crashed: ${e.message}`));
  };
  return worker;
}

/**
 * Kills the worker and settles everything waiting on it. Rejecting matters: clearing the
 * map without it would leave every in-flight processImage() promise pending forever, and
 * the upload queue awaits exactly those.
 */
function teardown(reason: Error) {
  for (const [, entry] of pending) entry.reject(reason);
  pending.clear();
  worker?.terminate();
  worker = null;
}

/** Frees the worker (and its AVIF WASM heap) - called on logout. */
export function disposeProcessor() {
  teardown(new Error('processor disposed'));
}

export async function processImage(file: Blob, mime: string): Promise<Processed> {
  const w = ensureWorker();
  const id = `p${++seq}`;
  // A Blob is not transferable, so read it once here and hand over the ArrayBuffer.
  const buffer = await file.arrayBuffer();

  const req: ProcessRequest = {
    id,
    buffer,
    type: file.type || 'image/jpeg',
    logoUrl: new URL(`${base}/${config.logoFile}`, location.href).href,
    maxLongEdge: config.maxLongEdge,
    quality: config.quality,
    mime,
    logoWidthFraction: config.logoWidthFraction,
    logoPaddingFraction: config.logoPaddingFraction,
    grade: config.grade
  };

  return new Promise<Processed>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage(req, [buffer]);
  });
}
