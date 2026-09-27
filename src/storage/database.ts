const DB_NAME = 'local-transcribe';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meetings')) {
        db.createObjectStore('meetings', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('segments')) {
        const store = db.createObjectStore('segments', { keyPath: 'id' });
        store.createIndex('by-meeting', 'meetingId', { unique: false });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function tx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => IDBRequest<any>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(stores, mode);
        const req = fn(transaction);
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

export const db = {
  get<T>(store: string, key: string): Promise<T | undefined> {
    return tx<T | undefined>([store], 'readonly', (t) =>
      t.objectStore(store).get(key),
    );
  },
  put<T>(store: string, value: T): Promise<void> {
    return tx<void>([store], 'readwrite', (t) => t.objectStore(store).put(value)).then(
      () => undefined,
    );
  },
  delete(store: string, key: string): Promise<void> {
    return tx<undefined>([store], 'readwrite', (t) => t.objectStore(store).delete(key)).then(
      () => undefined,
    );
  },
  getAll<T>(store: string): Promise<T[]> {
    return tx<T[]>([store], 'readonly', (t) => t.objectStore(store).getAll());
  },
  getAllByIndex<T>(store: string, index: string, key: string): Promise<T[]> {
    return openDatabase().then(
      (dbInstance) =>
        new Promise<T[]>((resolve, reject) => {
          const transaction = dbInstance.transaction([store], 'readonly');
          const req = transaction.objectStore(store).index(index).getAll(key);
          req.onsuccess = () => resolve(req.result as T[]);
          req.onerror = () => reject(req.error ?? new Error('IndexedDB index read failed'));
        }),
    );
  },
  kvGet<T>(key: string): Promise<T | undefined> {
    return db.get<{ key: string; value: T }>('kv', key).then((row) => row?.value);
  },
  kvSet<T>(key: string, value: T): Promise<void> {
    return db.put('kv', { key, value });
  },
  kvDelete(key: string): Promise<void> {
    return db.delete('kv', key);
  },
};
