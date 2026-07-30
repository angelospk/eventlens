import type { QueueItem } from './types';
import type { QueueStore } from './upload-queue';

const STORE = 'queue';
// Fingerprints of photographs that reached the server. Kept after the queue row is gone so
// that re-picking the same file later is recognised instead of uploading it twice.
const SENT = 'sent';
const DB_VERSION = 2;

// How long to wait for the database before deciding it is never coming. IndexedDB can
// simply never answer: another tab holding an old version blocks the upgrade, and Safari
// in private mode has been known to leave the request hanging. Rejecting is far better
// than hanging, because a hung open makes every enqueue await forever and the photographer
// taps "choose photos" and watches nothing happen, with no error to explain it.
const OPEN_TIMEOUT_MS = 10_000;

function open(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Η τοπική αποθήκευση δεν είναι διαθέσιμη (${why}).`));
    };

    const timer = setTimeout(() => fail('timeout'), OPEN_TIMEOUT_MS);
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(dbName, DB_VERSION);
    } catch (e) {
      clearTimeout(timer);
      fail(String(e));
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      // Guarded individually: an install from before the `sent` store existed upgrades in
      // place and must not try to recreate the queue it already has.
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SENT)) db.createObjectStore(SENT, { keyPath: 'fingerprint' });
    };
    req.onsuccess = () =>
      done(() => {
        const db = req.result;
        // Another context wants to upgrade the schema and cannot while this connection is
        // open. Yield immediately. Without this, a photographer running the installed app
        // and the same page in Safari deadlocks the upgrade: neither side can open the
        // database, and the app reports that storage is unavailable on a device where it
        // is perfectly fine.
        db.onversionchange = () => db.close();
        resolve(db);
      });
    req.onerror = () => done(() => reject(req.error ?? new Error('indexedDB open failed')));
    // A connection elsewhere refused to yield, so say what to do about it.
    req.onblocked = () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(
        new Error('Η εφαρμογή είναι ανοιχτή και αλλού. Κλείσε τις άλλες καρτέλες και ξαναδοκίμασε.')
      );
    };
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
  storeName: string = STORE
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbStore implements QueueStore {
  private dbp: Promise<IDBDatabase>;
  constructor(dbName = 'eventlens-queue') {
    this.dbp = open(dbName);
    // Anything awaiting dbp still sees the rejection; this only stops the browser from
    // reporting it as unhandled when the failure happens before the first call.
    this.dbp.catch(() => {});
  }

  async add(item: QueueItem) { await tx(await this.dbp, 'readwrite', (s) => s.put(item)); }

  // Read-modify-write inside ONE readwrite transaction to avoid lost updates
  // (e.g. processor writing avif/bytes racing with retry writing status/attempts).
  async update(id: string, patch: Partial<QueueItem>) {
    const db = await this.dbp;
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      const s = t.objectStore(STORE);
      const getReq = s.get(id);
      getReq.onsuccess = () => {
        const cur = getReq.result as QueueItem | undefined;
        if (!cur) return; // item already removed
        s.put({ ...cur, ...patch });
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  async remove(id: string) { await tx(await this.dbp, 'readwrite', (s) => s.delete(id)); }

  async all() {
    return tx<QueueItem[]>(await this.dbp, 'readonly', (s) => s.getAll() as IDBRequest<QueueItem[]>);
  }

  /** Records that this exact file made it to the server. */
  async markSent(fingerprint: string) {
    await tx(
      await this.dbp,
      'readwrite',
      (s) => s.put({ fingerprint, at: Date.now() }),
      SENT
    );
  }

  /**
   * Releases the connection. Matters on the fallback path: a database that opens but then
   * refuses transactions would otherwise keep an idle connection alive, and an open
   * connection is exactly what blocks another tab from upgrading the schema.
   */
  async close() {
    try {
      (await this.dbp).close();
    } catch {
      // Never opened, or already closed.
    }
  }

  async wasSent(fingerprint: string) {
    const row = await tx<{ fingerprint: string } | undefined>(
      await this.dbp,
      'readonly',
      (s) => s.get(fingerprint) as IDBRequest<{ fingerprint: string } | undefined>,
      SENT
    );
    return Boolean(row);
  }
}

/**
 * The queue with no database behind it.
 *
 * IndexedDB can refuse to open: another tab holding an older schema, Safari in private
 * mode, a profile with storage disabled. Before this existed, that refusal stopped the
 * photographer from queueing anything at all, which at an event is the worst possible
 * failure — the photographs are right there and the app says no.
 *
 * Everything works exactly as before while the app stays open. The only thing lost is
 * surviving a reload, which is a far smaller problem than not being able to upload.
 */
export class MemoryStore implements QueueStore {
  private items = new Map<string, QueueItem>();
  private sent = new Set<string>();

  async add(item: QueueItem) {
    this.items.set(item.id, { ...item });
  }

  async update(id: string, patch: Partial<QueueItem>) {
    const cur = this.items.get(id);
    if (cur) this.items.set(id, { ...cur, ...patch });
  }

  async remove(id: string) {
    this.items.delete(id);
  }

  async all() {
    return [...this.items.values()];
  }

  async markSent(fingerprint: string) {
    this.sent.add(fingerprint);
  }

  async wasSent(fingerprint: string) {
    return this.sent.has(fingerprint);
  }
}

export interface QueueStorage {
  store: QueueStore & { markSent(f: string): Promise<void>; wasSent(f: string): Promise<boolean> };
  /** True when the database was unavailable and the queue lives only in memory. */
  ephemeral: boolean;
  reason?: string;
}

/**
 * Opens the durable queue, falling back to memory rather than failing the upload.
 *
 * The probe is a real read, not just an open: a database that opens and then rejects every
 * transaction would otherwise pass here and fail on the first photograph.
 */
export async function createQueueStorage(dbName = 'eventlens-queue'): Promise<QueueStorage> {
  const idb = new IdbStore(dbName);
  try {
    await idb.all();
    return { store: idb, ephemeral: false };
  } catch (e) {
    await idb.close();
    return {
      store: new MemoryStore(),
      ephemeral: true,
      reason: e instanceof Error ? e.message : String(e)
    };
  }
}
