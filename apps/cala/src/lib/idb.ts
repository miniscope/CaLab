/** Small IndexedDB helpers shared by the app's stores (each store keeps one object store). */

/** A request as a promise (rejects with the request's error). */
export function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'));
  });
}

/**
 * A lazy opener of database `name` (version 1) with one object store `store` keyed by `keyPath`.
 * The database opens once, on the first call; it resolves null where IndexedDB does not exist
 * (`factory` undefined) or cannot be opened (an error, a blocked upgrade, a throw), so the store
 * using it can fall back to an inert one.
 */
export function lazyIdb(
  factory: IDBFactory | undefined,
  name: string,
  store: string,
  keyPath: string,
): () => Promise<IDBDatabase | null> {
  let dbPromise: Promise<IDBDatabase | null> | null = null;
  return () => {
    if (!factory) return Promise.resolve(null);
    dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = factory.open(name, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(store, { keyPath });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return dbPromise;
  };
}
