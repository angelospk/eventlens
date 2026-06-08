import type { QueueItem } from './types';

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
  constructor(
    private store: QueueStore,
    private uploader: Uploader,
    private retry: RetryPolicy,
    private onChange: () => void = () => {}
  ) {}

  async enqueue(item: QueueItem) {
    await this.store.add(item);
    this.onChange();
  }

  // Cross-tab single-flight via Web Locks (no-op in non-browser test env).
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = (globalThis as any).navigator?.locks;
    return locks?.request ? locks.request('eventlens-upload', fn) : fn();
  }

  /** Process runnable items one-by-one until none remain. Safe to call repeatedly. */
  async drain() {
    if (this.running) { this.dirty = true; return; } // re-pass after current loop
    await this.withLock(async () => {
      this.running = true;
      try {
        do {
          this.dirty = false;
          for (;;) {
            const items = await this.store.all();
            const next = items.find((i) => isRunnable(i, this.retry.maxAttempts));
            if (!next) break;
            await this.process(next);
          }
        } while (this.dirty); // an enqueue happened mid-drain → another pass
      } finally {
        this.running = false;
        this.onChange();
      }
    });
  }

  private async process(it: QueueItem) {
    const attempts = it.attempts + 1;
    await this.store.update(it.id, { status: 'uploading', attempts });
    this.onChange();
    try {
      await this.uploader.run(it);
      await this.store.remove(it.id); // success → drop from queue
    } catch (e) {
      const status = attempts >= this.retry.maxAttempts ? 'error' : 'pending';
      await this.store.update(it.id, { status, lastError: String(e) });
      this.onChange();
      if (status === 'pending') {
        const backoff = Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** (attempts - 1));
        await sleep(backoff);
      }
    }
  }
}
