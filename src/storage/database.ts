import { loadNativeSettings, setNativeSetting } from '../platform/native-settings';
import { invokeDesktop } from '../platform/desktop';
import { isServerApp } from '../platform/server';

const DB_NAME = 'local-transcribe';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

/** IndexedDB could not be opened at all (see `storageErrorHint`). */
export class DatabaseOpenError extends Error {
  constructor(readonly cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause ?? 'unknown error');
    super(`The app database could not be opened (${detail}).`);
    this.name = 'DatabaseOpenError';
  }
}

function openOnce(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
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
    req.onsuccess = () => {
      const db = req.result;
      // Another instance upgrading, or WebKit dropping the connection (its
      // storage process restarted): reopen on next use instead of failing
      // every later transaction with InvalidStateError.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB is in use by another window of the app'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  // One retry: right after an update/restart the previous instance may still
  // hold the database for a moment.
  const attempt = openOnce().catch(
    () => new Promise<IDBDatabase>((r) => setTimeout(r, 400)).then(() => openOnce()),
  );
  dbPromise = attempt.catch((err) => {
    // Never cache a failure: the next call tries again.
    dbPromise = null;
    throw new DatabaseOpenError(err);
  });
  return dbPromise;
}

/**
 * Settings go to the desktop settings file (survives updates and an
 * unreadable webview profile); caches and all other data stay in IndexedDB.
 */
function isSettingKey(key: string): boolean {
  return !key.startsWith('calendar-cache:');
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

/**
 * Server edition: the per-user meeting database lives on the server
 * (`server_db_*`, docs/SERVER.md) instead of IndexedDB.
 */
function remote<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  return invokeDesktop<T>(cmd, args);
}

export const db = {
  get<T>(store: string, key: string): Promise<T | undefined> {
    if (isServerApp()) {
      return remote<T | null>('server_db_get', { store, key }).then((v) => v ?? undefined);
    }
    return tx<T | undefined>([store], 'readonly', (t) =>
      t.objectStore(store).get(key),
    );
  },
  put<T>(store: string, value: T): Promise<void> {
    if (isServerApp()) return remote<void>('server_db_put', { store, value }).then(() => undefined);
    return tx<void>([store], 'readwrite', (t) => t.objectStore(store).put(value)).then(
      () => undefined,
    );
  },
  delete(store: string, key: string): Promise<void> {
    if (isServerApp()) return remote<void>('server_db_delete', { store, key }).then(() => undefined);
    return tx<undefined>([store], 'readwrite', (t) => t.objectStore(store).delete(key)).then(
      () => undefined,
    );
  },
  getAll<T>(store: string): Promise<T[]> {
    if (isServerApp()) return remote<T[] | null>('server_db_get_all', { store }).then((v) => v ?? []);
    return tx<T[]>([store], 'readonly', (t) => t.objectStore(store).getAll());
  },
  getAllByIndex<T>(store: string, index: string, key: string): Promise<T[]> {
    if (isServerApp()) {
      return remote<T[] | null>('server_db_get_by_index', { store, index, key }).then((v) => v ?? []);
    }
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
  /**
   * Run `fn` inside one transaction over `stores`; resolves when it commits.
   * `fn` may issue further requests from request callbacks.
   */
  transaction(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => void): Promise<void> {
    // Multi-step transactions have dedicated server commands (updateMeeting,
    // commitTranscript, …): callers check `isServerApp()` first.
    if (isServerApp()) return Promise.reject(new Error('IndexedDB transactions are not available on the server.'));
    return openDatabase().then(
      (dbInstance) =>
        new Promise<void>((resolve, reject) => {
          const transaction = dbInstance.transaction(stores, mode);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
          transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
          fn(transaction);
        }),
    );
  },
  async kvGet<T>(key: string): Promise<T | undefined> {
    const settings = isSettingKey(key) ? await loadNativeSettings() : null;
    if (settings) {
      if (key in settings) return (settings[key] ?? undefined) as T | undefined;
      // First run with the settings file: migrate the IndexedDB value once.
      const legacy = await idbKvGet<T>(key).catch(() => undefined);
      if (legacy !== undefined) await setNativeSetting(key, legacy).catch(() => undefined);
      return legacy;
    }
    return idbKvGet<T>(key);
  },
  async kvSet<T>(key: string, value: T): Promise<void> {
    const settings = isSettingKey(key) ? await loadNativeSettings() : null;
    if (settings) return setNativeSetting(key, value);
    return db.put('kv', { key, value });
  },
  async kvDelete(key: string): Promise<void> {
    const settings = isSettingKey(key) ? await loadNativeSettings() : null;
    if (settings) {
      await setNativeSetting(key, undefined);
      await db.delete('kv', key).catch(() => undefined);
      return;
    }
    return db.delete('kv', key);
  },
};

function idbKvGet<T>(key: string): Promise<T | undefined> {
  return db.get<{ key: string; value: T }>('kv', key).then((row) => row?.value);
}
