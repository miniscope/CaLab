/**
 * Per-device cache of the sensor flat field, in this browser's IndexedDB
 * (database `cala-flatfield`). A map is a property of the sensor, so a later
 * recording from the same device starts with it in force instead of waiting
 * for the first estimate. Every access is wrapped: with IndexedDB unavailable
 * (private window, blocked site data, Node) reads return nothing and writes do
 * nothing; the app works the same without it.
 */
import type { FlatFieldKey, FlatFieldKeySource, FlatFieldMap } from './flat-field.ts';

/** What is stored per device key. */
export interface FlatFieldRecord {
  key: string;
  keySource: FlatFieldKeySource;
  width: number;
  height: number;
  gain: Float32Array;
  offset: Float32Array;
  dark: number;
  framesUsed: number;
  binsUsed: number;
  gainSd: number;
  updatedAt: number;
}

/** The storage the pipeline store talks to (a fake in tests). */
export interface FlatFieldCache {
  /** The stored map for `key` when its frame size is `width x height`, else null. Never rejects. */
  get(key: string, width: number, height: number): Promise<FlatFieldRecord | null>;
  /** Store a map. Never rejects. */
  put(record: FlatFieldRecord): Promise<void>;
}

const DB_NAME = 'cala-flatfield';
const STORE = 'maps';

/** A record from a map. */
export function recordFromMap(
  key: FlatFieldKey,
  width: number,
  height: number,
  map: FlatFieldMap,
  updatedAt: number,
): FlatFieldRecord {
  return {
    key: key.key,
    keySource: key.source,
    width,
    height,
    gain: map.gain,
    offset: map.offset,
    dark: map.dark,
    framesUsed: map.framesUsed,
    binsUsed: map.binsUsed,
    gainSd: map.gainSd,
    updatedAt,
  };
}

/** The map of a record. */
export function mapFromRecord(r: FlatFieldRecord): FlatFieldMap {
  return {
    gain: r.gain,
    offset: r.offset,
    dark: r.dark,
    binsUsed: r.binsUsed,
    framesUsed: r.framesUsed,
    gainSd: r.gainSd,
  };
}

/** True when a stored record can seed a run of `width x height` frames. */
export function recordFits(r: FlatFieldRecord | null | undefined, w: number, h: number): boolean {
  return (
    !!r &&
    r.width === w &&
    r.height === h &&
    r.gain instanceof Float32Array &&
    r.gain.length === w * h &&
    (r.offset.length === 0 || r.offset.length === w * h)
  );
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'));
  });
}

/** The IndexedDB cache (or an inert one where IndexedDB does not exist). */
export function createIndexedDbFlatFieldCache(
  factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB,
): FlatFieldCache {
  let dbPromise: Promise<IDBDatabase | null> | null = null;
  const open = (): Promise<IDBDatabase | null> => {
    if (!factory) return Promise.resolve(null);
    dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = factory.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return dbPromise;
  };
  return {
    async get(key, width, height) {
      try {
        const db = await open();
        if (!db) return null;
        const rec = await request<FlatFieldRecord | undefined>(
          db.transaction(STORE, 'readonly').objectStore(STORE).get(key),
        );
        return recordFits(rec, width, height) ? (rec ?? null) : null;
      } catch {
        return null;
      }
    },
    async put(record) {
      try {
        const db = await open();
        if (!db) return;
        await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(record));
      } catch {
        // Quota or a closed database: the cache is an optimisation.
      }
    },
  };
}
