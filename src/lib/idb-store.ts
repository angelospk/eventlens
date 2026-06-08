import type { QueueItem } from './types';
import type { QueueStore } from './upload-queue';

const STORE = 'queue';

function open(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbStore implements QueueStore {
  private dbp: Promise<IDBDatabase>;
  constructor(dbName = 'eventlens-queue') { this.dbp = open(dbName); }

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
}
