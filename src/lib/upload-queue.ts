import type { QueueItem } from './types';
import { describeError, isAlreadyUploaded, isNetworkError, isNonRetryable } from './errors';
import { log } from './log';

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

/** How long the lock may be out of reach before that becomes something worth saying. */
const LOCK_WARN_MS = 15_000;
/** The same, for a storage operation that has gone quiet rather than failed. */
const STALL_WARN_MS = 10_000;

/**
 * Notes in the log that something has taken suspiciously long, and stops watching when it
 * finishes. For the operations that can hang rather than fail — the ones that leave no
 * exception to catch and so used to leave no trace either.
 */
function watchStall(what: string, ms = STALL_WARN_MS): () => void {
  const timer = setTimeout(() => log('queue', `${what} (${Math.round(ms / 1000)}s and counting)`), ms);
  return () => clearTimeout(timer);
}

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
  /** Set only while waiting for the lock, so a stop can call the wait off. */
  private locking: AbortController | null = null;
  private _completed = 0;
  private _lastDone: { name: string; at: number; file: Blob } | null = null;
  /** Set while the lock has been out of reach long enough that it needs explaining. */
  private _blocked = false;
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
   * The photograph this instance is actually working on, if any. A row can read as
   * 'uploading' in the database without this instance being the one doing it — another tab
   * may hold the queue, or the app may have been killed mid-attempt. The interface has to
   * go by this instead, or it shows several photographs uploading at once when only ever
   * one is, which reads as everything being stuck.
   */
  get activeId(): string | null {
    for (const id of this.inFlight.keys()) return id;
    return null;
  }

  /**
   * True once the network has failed us repeatedly. One failure is noise; two in a row
   * means the photographer should be told the connection is the problem, not their photos.
   */
  get struggling() { return this.netFails >= 2; }

  /**
   * True when this queue has been waiting on the cross-context lock long enough that the
   * only honest explanation is another window. Uploading looks identical to being wedged
   * from the outside — nothing moves, nothing errors — so it has to be said out loud.
   */
  get blocked() { return this._blocked; }

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
        log('queue', `skipped ${item.originalName}: already in the queue`);
        return 'duplicate';
      }
      if (await this.store.wasSent?.(item.fingerprint)) {
        log('queue', `skipped ${item.originalName}: already sent`);
        return 'duplicate';
      }
    }
    await this.store.add(item);
    log('queue', `queued ${item.id.slice(0, 8)} ${item.originalName}`);
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
   * Puts photographs back in line, whatever state they are in, and restarts the drain.
   *
   * Anything currently in the air is abandoned first — that is the whole point for a wedged
   * upload — but the row itself is kept. Doing this with `cancel` instead would delete the
   * photograph and then update a row that no longer exists: "try again" would quietly mean
   * "throw away".
   */
  async retryMany(ids: string[]) {
    for (const id of ids) {
      const controller = this.inFlight.get(id);
      if (controller) {
        // Disowned *before* the abort lands. An attempt only writes its outcome while it
        // still owns its entry here, so the failure this abort is about to cause cannot
        // come back a moment later and undo the reset. Waiting for the attempt to unwind
        // instead would be a guess: nothing bounds how long a stuck one takes.
        this.inFlight.delete(id);
        controller.abort(new Error('retry'));
      }
      try {
        await this.store.update(id, UploadQueue.RESET);
      } catch {
        // Row is gone or the store is unavailable; nothing to retry.
      }
    }
    log('queue', `retry requested for ${ids.length}`);
    this.onChange();
    // The drain may be asleep on a backoff it set before the reset. Without this the
    // photographer presses "try again" and watches nothing happen for up to half a minute.
    this.wake?.();
    return this.drain();
  }

  /**
   * One item. The returned promise resolves when the drain finishes, so callers that care
   * (tests, scripts) can await the outcome; the UI fires and forgets.
   */
  retryItem(id: string) {
    return this.retryMany([id]);
  }

  /** Same, for every item sitting in 'error' - the "try everything again" button. */
  async retryAll() {
    const failed = (await this.store.all()).filter((i) => i.status === 'error');
    return this.retryMany(failed.map((i) => i.id));
  }

  async discard(id: string) {
    await this.store.remove(id);
    this.onChange();
  }

  /**
   * Cross-context single-flight. Two windows on the same database would otherwise each
   * pick photographs the other is already sending, and each reset rows the other is
   * mid-way through, so neither finishes.
   *
   * A plain request, waited on, is the whole mechanism. An earlier version stepped over
   * the lock once a shared heartbeat went quiet, on the theory that a frozen page could
   * hold it forever — but a heartbeat only proves a timer fired, not that anything is
   * being uploaded, and a phone that suspends a background tab produces both false
   * readings: beats too fresh to ever take over, and beats stale enough to take over from
   * a holder that then wakes up and carries on. Locks are released when a document goes
   * away, so waiting is both correct and sufficient.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T | null> {
    const locks = (globalThis as any).navigator?.locks;
    if (!locks?.request) return fn();
    // The wait is abortable so `stop()` can end it. Without that, a queue waiting on a
    // lock another window holds never settles its drain, `running` stays true for good,
    // and every later request to upload quietly defers to a loop that will never run.
    this.locking = new AbortController();
    const asked = Date.now();
    // Waiting on a lock is indistinguishable from being wedged: no progress, no error, no
    // log line. If it goes on this long, something else is holding it and the photographer
    // deserves to be told which of the two is happening.
    const watchdog = setTimeout(() => {
      this._blocked = true;
      log('queue', 'waiting for the upload lock — the app is open somewhere else');
      this.onChange();
    }, LOCK_WARN_MS);
    // Whether we ever got in. Everything below turns on this: an abort before the callback
    // ran is a stop, and the same abort after it ran came from the work itself.
    let acquired = false;
    const clear = () => {
      clearTimeout(watchdog);
      if (!this._blocked) return;
      this._blocked = false;
      // Only the successful path gets to announce a wait that ended. Clearing the flag on
      // the way out of an abandoned wait still has to happen, or the screen keeps saying
      // "open somewhere else" long after nothing is waiting for anything.
      if (acquired) {
        log('queue', `got the upload lock after ${Math.round((Date.now() - asked) / 1000)}s`);
      }
      this.onChange();
    };
    try {
      return (await locks.request('eventlens-upload', { signal: this.locking.signal }, () => {
        acquired = true;
        clear();
        return fn();
      })) as T;
    } catch (e) {
      // Aborts are only ours to swallow before the lock was granted. `locks.request` adopts
      // whatever the callback returns, so an AbortError from an IndexedDB request inside
      // the work arrives here looking identical to a `stop()` — and returning null for it
      // would tell `run` the queue was stopped, ending the pass with every photograph still
      // pending and not one word about why. That is the exact silence this whole change
      // exists to remove.
      if (!acquired && (e as Error)?.name === 'AbortError') return null;
      throw e;
    } finally {
      clear();
      this.locking = null;
    }
  }

  /**
   * Process runnable items one-by-one until none remain. Safe to call repeatedly: a call
   * made while a drain is already running marks the queue dirty and returns *that* drain's
   * promise, so `await queue.retryAll()` resolves once the work is actually done rather
   * than the instant it was requested.
   */
  drain(): Promise<void> {
    this.stopped = false;
    // Set unconditionally: a request made while a loop is running is honoured by that loop's
    // next turn, and a request made as one is finishing starts a new one.
    this.dirty = true;
    // A loop asleep on someone else's backoff has to be told, or a freshly picked
    // photograph waits out a wait that has nothing to do with it — up to half a minute of
    // the picker closing and nothing appearing to happen.
    this.wake?.();
    if (!this.running) {
      log('queue', 'drain starting');
      // Claimed synchronously. `loop` does not reach its body until the lock is acquired, so
      // claiming in there would let two calls in the same tick both start a loop.
      this.running = true;
      this.active = this.loop().finally(() => {
        this.active = null;
      });
    }
    return this.active ?? Promise.resolve();
  }

  /**
   * Owns the running flag for exactly as long as there is work. The flag is cleared in the
   * same turn as the loop condition fails, with nothing awaited in between, so a `drain`
   * either sets `dirty` in time to be picked up or finds the queue idle and starts a fresh
   * loop. Anything less strict and a `stop` followed by a retry leaves the queue dead: the
   * pass exits early, the retry sees `running` and defers to it, and neither does the work.
   */
  private async loop() {
    try {
      while (this.dirty && !this.stopped) {
        this.dirty = false;
        try {
          await this.run();
        } catch (e) {
          // A pass can only throw if the store itself failed in a way `run` does not
          // handle. Letting it escape would end the loop with every photograph still
          // 'pending' and nothing anywhere saying why — which is precisely the failure
          // that took a night to find. Say it, then stop trying this pass.
          log('queue', `drain pass threw: ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        }
      }
      log('queue', 'drain finished');
    } finally {
      this.running = false;
      this.onChange();
    }
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
      if (stale.length) {
        log('queue', `recovered ${stale.length} interrupted by a close or crash`);
        this.onChange();
      }
    } catch {
      // Not worth failing the drain over; the rows are retried regardless.
    }
  }

  /** One pass: work through everything runnable until nothing is left to do right now. */
  private async run() {
    // Items the store itself refused to touch this pass. Without this the loop would
    // pick the same unwritable item forever and spin the CPU.
    const skip = new Set<string>();
    let repaired = false;
    for (;;) {
      if (this.stopped) return;
      // The lock is taken per photograph rather than held across the whole pass: a queue
      // sitting out a backoff must not keep another window from uploading meanwhile.
      const wait = await this.withLock(async () => {
        if (!repaired) {
          // Inside the lock on purpose. A contender that repaired rows from outside would
          // reset the holder's row while it was still being uploaded.
          await this.reclaimInterrupted();
          repaired = true;
        }
        // The lock is held from here. A store operation that never settles now stalls the
        // drain from *inside*, which produced no log line at all: the watchdog above has
        // already been cleared, `running` stays true, and every later drain quietly joins
        // the run that is stuck. So the read gets its own watch.
        const settled = watchStall('the queue is not answering from storage');
        let all: QueueItem[];
        try {
          all = await this.store.all();
        } finally {
          settled();
        }
        const items = all
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
        if (items.length === 0) {
          // The one outcome that used to leave no trace at all. A queue full of
          // photographs and nothing runnable in it means they were skipped, exhausted or
          // already failed — all of which look identical on screen, and none of which the
          // photographer can act on without being told which.
          if (all.length) {
            const by = all.reduce<Record<string, number>>((acc, i) => {
              acc[i.status] = (acc[i.status] ?? 0) + 1;
              return acc;
            }, {});
            const shape = Object.entries(by).map(([k, v]) => `${k}=${v}`).join(' ');
            // The status alone would not explain it: a row can read 'pending' and still be
            // ineligible, which is the one combination that looks like the queue ignoring
            // work for no reason. So the two things that do that are counted by name.
            const exhausted = all.filter(
              (i) => (i.status === 'pending' || i.status === 'uploading') && i.attempts >= this.retry.maxAttempts
            ).length;
            const why = [
              exhausted ? `out of attempts=${exhausted}` : '',
              skip.size ? `unwritable=${skip.size}` : ''
            ].filter(Boolean).join(' ');
            log('queue', `nothing to run · ${shape}${why ? ` · ${why}` : ''}`);
          }
          return -1;
        }
        const now = Date.now();
        // Prefer an item whose backoff has elapsed (or never failed).
        const ready = items.find((i) => !i.nextAttemptAt || i.nextAttemptAt <= now);
        if (ready) {
          if (!(await this.process(ready))) {
            log('queue', `${ready.id.slice(0, 8)} ${ready.originalName}: storage refused the write`);
            skip.add(ready.id);
          }
          return 0;
        }
        // Everything runnable is still in backoff: report how long, and wait for it with
        // the lock released. (A newly-enqueued item has no nextAttemptAt, so it would
        // have been 'ready'.)
        // Only real timestamps: a corrupt row with a NaN in it would otherwise poison the
        // minimum and turn the wait into a busy loop.
        const times = items.map((i) => i.nextAttemptAt as number).filter(Number.isFinite);
        if (!times.length) return 250;
        const ms = Math.max(0, Math.min(...times) - now);
        log('queue', `all ${items.length} waiting out a backoff · ${Math.round(ms / 1000)}s`);
        return ms;
      });
      if (wait === null || wait < 0) return; // stopped, or nothing left to do
      if (wait > 0) await this.waitUntil(wait);
    }
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
    this.locking?.abort();
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
    log('queue', `picking ${it.id.slice(0, 8)} ${it.originalName} try ${tries}`);
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
      log('queue', `done ${it.id.slice(0, 8)} ${it.originalName} on try ${tries}`);
      await this.finish(it.id, it.fingerprint, it);
      return true;
    } catch (e) {
      // The server already has it: count it as done rather than scaring the photographer
      // with a failure for a photo that is actually up.
      if (isAlreadyUploaded(e)) {
        log('queue', `${it.id.slice(0, 8)} was already on the server`);
        this.netFails = 0;
        await this.finish(it.id, it.fingerprint, it);
        return true;
      }
      // Superseded: the photographer asked for this one to start over, so the failure that
      // request caused is not news. Writing it would put the item straight back into the
      // error/backoff state the retry just cleared.
      if (this.inFlight.get(it.id) !== controller) return true;
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
      log(
        'queue',
        `FAILED ${it.id.slice(0, 8)} ${it.originalName} try ${tries} ` +
          `${networky ? 'network' : 'server/file'}${terminal ? ' GIVING UP' : ` retry in ${Math.round(backoff / 1000)}s`}: ` +
          (e instanceof Error ? e.message : String(e))
      );
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
      // Only if this attempt is still the current one: a retry may have already handed the
      // slot to a newer attempt, and clearing it here would disown that one instead.
      if (this.inFlight.get(it.id) === controller) {
        this.inFlight.delete(it.id);
        // Announced after clearing, not before. The interface reads `activeId` from this
        // map, so without a second notification a photograph waiting out a backoff keeps
        // being described as uploading.
        this.onChange();
      }
    }
  }

  /**
   * Abandons one photograph: aborts the request if it is in the air, and drops the row.
   * Used for something that is clearly not going to arrive, so the rest can move.
   */
  async cancel(id: string) {
    log('queue', `cancelled ${id.slice(0, 8)}`);
    const controller = this.inFlight.get(id);
    this.inFlight.delete(id);
    controller?.abort(new Error('cancelled'));
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
