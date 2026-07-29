import type { QueueItem } from './types';
import { isAlreadyUploaded, isNonRetryable } from './errors';

export interface QueueStore {
  add(item: QueueItem): Promise<void>;
  update(id: string, patch: Partial<QueueItem>): Promise<void>;
  remove(id: string): Promise<void>;
  all(): Promise<QueueItem[]>;
}

export interface Uploader {
  // Process (logo+filter+AVIF) and upload one item. Throws on failure.
  run(item: QueueItem): Promise<void>;
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
  private _completed = 0;
  constructor(
    private store: QueueStore,
    private uploader: Uploader,
    private retry: RetryPolicy,
    private onChange: () => void = () => {}
  ) {}

  /** Number of items successfully uploaded this session (they are removed from the store). */
  get completed() { return this._completed; }

  async enqueue(item: QueueItem) {
    await this.store.add(item);
    this.onChange();
  }

  private static readonly RESET: Partial<QueueItem> = {
    status: 'pending',
    attempts: 0,
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

  // Cross-tab single-flight via Web Locks (no-op in non-browser test env).
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = (globalThis as any).navigator?.locks;
    return locks?.request ? locks.request('eventlens-upload', fn) : fn();
  }

  /**
   * Process runnable items one-by-one until none remain. Safe to call repeatedly: a call
   * made while a drain is already running marks the queue dirty and returns *that* drain's
   * promise, so `await queue.retryAll()` resolves once the work is actually done rather
   * than the instant it was requested.
   */
  drain(): Promise<void> {
    if (this.running) {
      this.dirty = true;
      return this.active ?? Promise.resolve();
    }
    this.active = this.run().finally(() => {
      this.active = null;
    });
    return this.active;
  }

  private async run() {
    await this.withLock(async () => {
      this.running = true;
      try {
        do {
          this.dirty = false;
          // Items the store itself refused to touch this pass. Without this the loop would
          // pick the same unwritable item forever and spin the CPU.
          const skip = new Set<string>();
          for (;;) {
            const items = (await this.store.all())
              .filter((i) => isRunnable(i, this.retry.maxAttempts) && !skip.has(i.id))
              // Oldest first, so the night uploads in the order it was shot.
              .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
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
            await sleep(Math.max(0, soonest - now));
          }
        } while (this.dirty); // an enqueue happened mid-drain → another pass
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
  private async process(it: QueueItem): Promise<boolean> {
    const attempts = it.attempts + 1;
    try {
      await this.store.update(it.id, { status: 'uploading', attempts });
    } catch {
      return false; // storage is unavailable (tab closing, quota); leave it for next open
    }
    this.onChange();
    try {
      await this.uploader.run(it);
      await this.finish(it.id);
      return true;
    } catch (e) {
      // The server already has it: count it as done rather than scaring the photographer
      // with a failure for a photo that is actually up.
      if (isAlreadyUploaded(e)) {
        await this.finish(it.id);
        return true;
      }
      // A wrong passcode or a broken file fails the same way forever - go straight to
      // 'error' instead of spending the whole backoff ladder rediscovering that.
      const terminal = isNonRetryable(e) || attempts >= this.retry.maxAttempts;
      const backoff = Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** (attempts - 1));
      try {
        await this.store.update(it.id, {
          status: terminal ? 'error' : 'pending',
          lastError: e instanceof Error ? e.message : String(e),
          nextAttemptAt: terminal ? undefined : Date.now() + backoff
        });
      } catch {
        return false;
      }
      this.onChange();
      return true;
    }
  }

  /**
   * The photo is on the server, so this always counts as done. If the row cannot be
   * deleted, it is at least marked 'done' so the drain stops treating it as work: without
   * that the same photo is uploaded again on every pass until it burns through maxAttempts.
   */
  private async finish(id: string) {
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
