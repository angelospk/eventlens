import { config } from './config';
import { createQueueStorage } from './idb-store';
import { UploadQueue, type QueueStore } from './upload-queue';
import { makeR2Uploader, type Stage } from './r2-client';
import { Session } from './session';
import type { QueueItem } from './types';

/**
 * The one upload queue the whole app shares.
 *
 * It used to belong to the photographer page, which meant leaving that page for the
 * manager screen and coming back built a second queue over the same database while the
 * first was still draining. The two then fought over the cross-tab lock and neither
 * finished: every photograph sat at "queued" indefinitely. Uploading is not a property of
 * a screen — a night's photographs have to keep going up while the manager approves them
 * — so the queue lives here, above routing, and outlives any page that shows it.
 *
 * Created on first use rather than at import time: nothing must touch IndexedDB while the
 * site is being prerendered, and a photographer who has not signed in has no queue at all.
 */
class Uploads {
  /** Everything still to go up. Written by the queue, read by whichever screen is open. */
  items = $state<QueueItem[]>([]);
  completed = $state(0);
  struggling = $state(false);
  ephemeral = $state(false);
  /** The photograph actually in flight, as opposed to one a stale row merely claims is. */
  activeId = $state<string | null>(null);
  stage = $state<{ id: string; stage: Stage } | null>(null);
  lastDone = $state<{ name: string; at: number; file: Blob } | null>(null);
  /** True once there is a queue to talk to. */
  ready = $state(false);

  // Reactive, not plain fields: the screens derive from these, and a plain field assigned
  // after the derivation was set up leaves them holding the null it started with.
  queue = $state<UploadQueue | null>(null);
  store = $state<QueueStore | null>(null);
  // A manager's token is accepted here too: same person, and being asked for a second
  // passcode just to upload is friction with nothing behind it.
  readonly session = new Session(config.workerUrl, 'photographer', undefined, ['manager']);

  private starting: Promise<void> | null = null;

  /** Idempotent, and safe to call from every page on every navigation. */
  start(): Promise<void> {
    if (!this.starting) this.starting = this.build();
    return this.starting;
  }

  private async build() {
    // Falls back to an in-memory queue rather than refusing to accept photographs when the
    // database will not open. Losing the queue on reload beats not being able to upload.
    const storage = await createQueueStorage();
    this.store = storage.store;
    this.ephemeral = storage.ephemeral;
    const uploader = makeR2Uploader({
      workerUrl: config.workerUrl,
      auth: () => this.session.headers(),
      onStage: (id, stage) => (this.stage = { id, stage })
    });
    this.queue = new UploadQueue(this.store, uploader, config.retry, () => this.refresh());
    this.ready = true;
    await this.refresh();
    this.queue.drain(); // resume anything left from a previous session
  }

  async refresh() {
    if (!this.store) return;
    // 'done' rows only exist when storage refused a delete after a successful upload. They
    // are finished work, so they must not show up as something still waiting.
    // Sorted the way the queue processes them, so the order on screen is the order the
    // photographs will actually arrive rather than the database's own key order.
    this.items = (await this.store.all())
      .filter((i) => i.status !== 'done')
      .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
    this.completed = this.queue?.completed ?? 0;
    this.struggling = this.queue?.struggling ?? false;
    this.activeId = this.queue?.activeId ?? null;
    this.lastDone = this.queue?.lastDone ?? null;
    if (!this.items.some((i) => i.id === this.stage?.id)) this.stage = null;
  }

  /**
   * Signing out has to take the queue down with it, credentials and all — and leave the
   * singleton genuinely unstarted. Keeping the built queue around would mean the next
   * sign-in gets `start()`'s already-resolved promise back and never resumes anything.
   */
  reset() {
    this.queue?.stop();
    this.session.signOut();
    this.queue = null;
    this.store = null;
    this.starting = null;
    this.ready = false;
    this.items = [];
    this.completed = 0;
    this.struggling = false;
    this.stage = null;
    this.activeId = null;
    this.lastDone = null;
  }
}

export const uploads = new Uploads();
