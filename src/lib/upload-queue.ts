import type { QueueItem } from './types';
import { describeError, isAlreadyUploaded, isNetworkError, isNonRetryable } from './errors';

export interface QueueStore {
  add(item: QueueItem): Promise<void>;
  update(id: string, patch: Partial<QueueItem>): Promise<void>;
  remove(id: string): Promise<void>;
  all(): Promise<QueueItem[]>;
  /**
   * Remembers which files already reached the server, so a photograph picked a second time
   * is recognised even after its queue row is long gone. Optional: the in-memory store used
   * by the tests, and any future store, can leave duplicate detection to the queue alone.
   */
  markSent?(fingerprint: string): Promise<void>;
  wasSent?(fingerprint: string): Promise<boolean>;
}

export interface Uploader {
  /**
   * Process and upload one item. Throws on failure.
   *
   * The signal lets the photographer abandon a photograph that is going nowhere. Without
   * it, "cancel" could only delete the row while the request carried on in the background
   * and the queue stayed blocked behind it.
   */
  run(item: QueueItem, signal?: AbortSignal): Promise<void>;
}

export interface RetryPolicy { baseMs: number; maxMs: number; maxAttempts: number; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Runnable = waiting to be tried, or left mid-flight by a crash/reload.
// 'error' items are NOT auto-retried (manual retry only); 'done' are removed.
function isRunnable(i: QueueItem, maxAttempts: number): boolean {
  return (i.status === 'pending' || i.status === 'uploading') && i.attempts < maxAttempts;
}

export class UploadQueue {
  private running = false;
  private dirty = false;
  private active: Promise<void> | null = null;
  // One controller per photograph currently being uploaded, so a single one can be
  // abandoned without disturbing the rest of the queue.
  private inFlight = new Map<string, AbortController>();
  // Consecutive failures caused by the network rather than by the server or the file.
  // `navigator.onLine` cannot see a hotspot that answers DHCP and nothing else, which is
  // the normal state of a field full of people, so the truth comes from real attempts.
  private netFails = 0;
  // Set while the drain loop is waiting out a backoff, so the wait can be cut short the
  // moment the device reports a connection again.
  private wake: (() => void) | null = null;
  private stopped = false;
  private _completed = 0;
  private _lastDone: { name: string; at: number; file: Blob } | null = null;
  constructor(
    private store: QueueStore,
    private uploader: Uploader,
    private retry: RetryPolicy,
    private onChange: () => void = () => {}
  ) {}

  /** Number of items successfully uploaded this session (they are removed from the store). */
  get completed() { return this._completed; }

  /** The most recent photograph to reach the server, for "where did I get to". */
  get lastDone() { return this._lastDone; }

  /**
   * True once the network has failed us repeatedly. One failure is noise; two in a row
   * means the photographer should be told the connection is the problem, not their photos.
   */
  get struggling() { return this.netFails >= 2; }

  /**
   * Adds a photograph unless it is already here or already sent.
   *
   * Re-picking files is the normal way this goes wrong at an event: the photographer opens
   * the picker, cannot remember which ones went last time, and selects the lot. Without
   * this the same photograph goes up twice and appears twice on the wall.
   */
  async enqueue(item: QueueItem): Promise<'queued' | 'duplicate'> {
    if (item.fingerprint) {
      const queued = await this.store.all();
      if (queued.some((i) => i.fingerprint === item.fingerprint && i.status !== 'done')) {
        return 'duplicate';
      }
      if (await this.store.wasSent?.(item.fingerprint)) return 'duplicate';
    }
    await this.store.add(item);
    this.onChange();
    return 'queued';
  }

  private static readonly RESET: Partial<QueueItem> = {
    status: 'pending',
    attempts: 0,
    tries: 0,
    lastError: undefined,
    nextAttemptAt: undefined
  };

  /**
   * Puts one failed item back in line and restarts the drain. The returned promise resolves
   * when the drain finishes, so callers that care (tests, scripts) can await the outcome;
   * the UI fires and forgets.
   */
  async retryItem(id: string) {
    await this.store.update(id, UploadQueue.RESET);
    this.onChange();
    return this.drain();
  }

  /** Same, for every item sitting in 'error' - the "try everything again" button. */
  async retryAll() {
    const failed = (await this.store.all()).filter((i) => i.status === 'error');
    for (const i of failed) await this.store.update(i.id, UploadQueue.RESET);
    this.onChange();
    return this.drain();
  }

  async discard(id: string) {
    await this.store.remove(id);
    this.onChange();
  }

  /**
   * Cross-tab single-flight, but never at the cost of not uploading at all.
   *
   * A plain `locks.request` waits for the lock forever. iOS does not reliably tear a page
   * down when the app is closed: a frozen previous instance can still hold it, and the new
   * one then waits for a release that is never coming. The photographs sit there, the
   * statuses stay as they were, and nothing explains it.
   *
   * So the lock is asked for, not waited on. If something else genuinely holds it we back
   * off briefly and ask again; if it is still held we go ahead anyway. Two drains at once
   * is wasteful but safe, because the server answers a photograph it already has with a
   * 409 that counts as success. A queue that never runs is not safe at all.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = (globalThis as any).navigator?.locks;
    if (!locks?.request) return fn();

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await locks.request(
        'eventlens-upload',
        { ifAvailable: true },
        async (lock: unknown) => (lock ? { held: true, value: await fn() } : { held: false })
      );
      if (result.held) return result.value as T;
      await sleep(1500);
    }
    return fn();
  }

  /**
   * Process runnable items one-by-one until none remain. Safe to call repeatedly: a call
   * made while a drain is already running marks the queue dirty and returns *that* drain's
   * promise, so `await queue.retryAll()` resolves once the work is actually done rather
   * than the instant it was requested.
   */
  drain(): Promise<void> {
    this.stopped = false;
    if (this.running) {
      this.dirty = true;
      return this.active ?? Promise.resolve();
    }
    this.active = this.run().finally(() => {
      this.active = null;
    });
    return this.active;
  }

  /**
   * Anything still marked 'uploading' when a drain begins was interrupted, not running:
   * the app was closed or killed mid-attempt. Left alone the interface shows several
   * photographs uploading at once when the queue only ever works on one, which reads as
   * everything being stuck.
   */
  private async reclaimInterrupted() {
    try {
      const stale = (await this.store.all()).filter(
        (i) => i.status === 'uploading' && !this.inFlight.has(i.id)
      );
      for (const i of stale) {
        await this.store.update(i.id, { status: 'pending', startedAt: undefined });
      }
      if (stale.length) this.onChange();
    } catch {
      // Not worth failing the drain over; the rows are retried regardless.
    }
  }

  private async run() {
    // Outside the lock on purpose: this only repairs how things are described, and it has
    // to happen even when another context is doing the uploading.
    await this.reclaimInterrupted();
    await this.withLock(async () => {
      this.running = true;
      try {
        do {
          this.dirty = false;
          // Items the store itself refused to touch this pass. Without this the loop would
          // pick the same unwritable item forever and spin the CPU.
          const skip = new Set<string>();
          for (;;) {
            if (this.stopped) return;
            const items = (await this.store.all())
              .filter((i) => isRunnable(i, this.retry.maxAttempts) && !skip.has(i.id))
              // Fewest attempts first, then oldest.
              //
              // Plain oldest-first means one troublesome photograph, an enormous file or one
              // that keeps timing out, takes the front of the queue on every single pass and
              // everything shot after it waits behind. Ordering by attempts lets a struggling
              // photo drift to the back on its own: it is still retried, just after the ones
              // that have not failed yet. Nothing is skipped, nothing is lost, the healthy
              // majority simply stops paying for the exception.
              .sort((a, b) => (a.tries ?? 0) - (b.tries ?? 0) || (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
            if (items.length === 0) break;
            const now = Date.now();
            // Prefer an item whose backoff has elapsed (or never failed).
            const ready = items.find((i) => !i.nextAttemptAt || i.nextAttemptAt <= now);
            if (ready) {
              if (!(await this.process(ready))) skip.add(ready.id);
              continue;
            }
            // All runnable items are still in backoff: wait until the soonest, then loop.
            // (A newly-enqueued item has no nextAttemptAt, so it would have been 'ready'.)
            const soonest = Math.min(...items.map((i) => i.nextAttemptAt as number));
            await this.waitUntil(Math.max(0, soonest - now));
          }
        } while (this.dirty && !this.stopped); // an enqueue happened mid-drain → another pass
      } finally {
        this.running = false;
        this.onChange();
      }
    });
  }

  /**
   * Runs one item to completion or failure. Never rejects: a throw here would kill the
   * drain loop and strand the queue in 'uploading' with the app still open and no sign
   * that anything is wrong. Returns false when the store could not be written, so the
   * caller can stop retrying that item this pass.
   */
  /** A backoff wait that `resume()` can interrupt. */
  private waitUntil(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  /**
   * The device says it has a connection again. Everything sitting in backoff should go now
   * rather than serve out a wait that was based on the network being down: at an event the
   * signal returns in bursts, and a photographer should not watch a full queue do nothing
   * for half a minute after the bars come back.
   */
  /**
   * Ends the drain loop. Needed because a network failure no longer exhausts the retry
   * ladder, so without this the queue would keep trying with credentials the user has
   * just signed out of, forever.
   */
  stop() {
    this.stopped = true;
    this.wake?.();
  }

  async resume() {
    this.stopped = false;
    const items = await this.store.all();
    for (const i of items) {
      if (i.status !== 'error' && i.nextAttemptAt) {
        await this.store.update(i.id, { nextAttemptAt: undefined });
      }
    }
    this.netFails = 0;
    this.wake?.();
    this.onChange();
    return this.drain();
  }

  private async process(it: QueueItem): Promise<boolean> {
    const tries = (it.tries ?? 0) + 1;
    const controller = new AbortController();
    this.inFlight.set(it.id, controller);
    try {
      // startedAt is what the interface reads to tell "working on it" apart from "wedged".
      await this.store.update(it.id, { status: 'uploading', tries, startedAt: Date.now() });
    } catch {
      this.inFlight.delete(it.id);
      return false; // storage is unavailable (tab closing, quota); leave it for next open
    }
    this.onChange();
    try {
      await this.uploader.run(it, controller.signal);
      this.netFails = 0;
      await this.finish(it.id, it.fingerprint, it);
      return true;
    } catch (e) {
      // The server already has it: count it as done rather than scaring the photographer
      // with a failure for a photo that is actually up.
      if (isAlreadyUploaded(e)) {
        this.netFails = 0;
        await this.finish(it.id, it.fingerprint, it);
        return true;
      }
      const networky = isNetworkError(e);
      this.netFails = networky ? this.netFails + 1 : 0;
      // A failure to reach the server says nothing about the photo, so it must not consume
      // the retry budget. Otherwise a long outage marks a whole night as failed and the
      // photographer has to notice and press retry on every one.
      const attempts = networky ? it.attempts : it.attempts + 1;
      // A wrong passcode or a broken file fails the same way forever - go straight to
      // 'error' instead of spending the whole backoff ladder rediscovering that.
      const terminal = isNonRetryable(e) || attempts >= this.retry.maxAttempts;
      const backoff = Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** Math.min(tries - 1, 20));
      try {
        await this.store.update(it.id, {
          attempts,
          status: terminal ? 'error' : 'pending',
          // Stored already translated: the queue is the only place that sees the raw
          // failure, and the UI should never have to interpret one.
          lastError: describeError(e),
          nextAttemptAt: terminal ? undefined : Date.now() + backoff
        });
      } catch {
        return false;
      }
      this.onChange();
      return true;
    } finally {
      this.inFlight.delete(it.id);
    }
  }

  /**
   * Abandons one photograph: aborts the request if it is in the air, and drops the row.
   * Used for something that is clearly not going to arrive, so the rest can move.
   */
  async cancel(id: string) {
    this.inFlight.get(id)?.abort(new Error('cancelled'));
    this.inFlight.delete(id);
    try {
      await this.store.remove(id);
    } catch {
      // Nothing more to do; it is gone from view either way.
    }
    this.onChange();
  }

  /**
   * The photo is on the server, so this always counts as done. If the row cannot be
   * deleted, it is at least marked 'done' so the drain stops treating it as work: without
   * that the same photo is uploaded again on every pass until it burns through maxAttempts.
   */
  private async finish(id: string, fingerprint?: string, item?: QueueItem) {
    // Remembered so the interface can show what went up last. Coming back to the app after
    // a break, the first question is always "where did I get to", and a count alone does
    // not answer it.
    if (item) this._lastDone = { name: item.originalName, at: Date.now(), file: item.file };
    if (fingerprint) {
      // Recorded before the row is dropped: if the delete fails, the photograph is still
      // known to have been sent and will not be queued again.
      try {
        await this.store.markSent?.(fingerprint);
      } catch {
        // Not fatal. The worst case is that re-picking this file uploads it again, and the
        // server answers that duplicate with a 409 which counts as success anyway.
      }
    }
    try {
      await this.store.remove(id);
    } catch {
      try {
        await this.store.update(id, { status: 'done' });
      } catch {
        // Storage is fully unavailable. The row stays 'uploading' and is retried on the
        // next open, where the Worker's 409 maps back to success anyway.
      }
    }
    this._completed++;
    this.onChange();
  }
}
