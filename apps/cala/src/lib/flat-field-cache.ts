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

/** Plausible per-pixel gain: sensor gain is within a few percent of 1, so 0.5 to 2 is generous. */
export const GAIN_MIN = 0.5;
export const GAIN_MAX = 2;

function allFinite(a: Float32Array, lo = -Infinity, hi = Infinity): boolean {
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (!Number.isFinite(v) || v < lo || v > hi) return false;
  }
  return true;
}

/**
 * True when a map is safe to apply to `w x h` frames: the arrays have the
 * frame's size (offset: empty or full), every gain is finite and plausible,
 * every offset and the dark level are finite. Checked on write and on read;
 * a map that fails is rejected whole (the run estimates fresh).
 */
export function mapIsValid(m: FlatFieldMap | null | undefined, w: number, h: number): boolean {
  return (
    !!m &&
    m.gain instanceof Float32Array &&
    m.offset instanceof Float32Array &&
    m.gain.length === w * h &&
    (m.offset.length === 0 || m.offset.length === w * h) &&
    Number.isFinite(m.dark) &&
    allFinite(m.gain, GAIN_MIN, GAIN_MAX) &&
    allFinite(m.offset)
  );
}

/** True when a stored record can seed a run of `width x height` frames. */
export function recordFits(r: FlatFieldRecord | null | undefined, w: number, h: number): boolean {
  return !!r && r.width === w && r.height === h && mapIsValid(mapFromRecord(r), w, h);
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
        // Never persist a map that would be rejected on read.
        if (!recordFits(record, record.width, record.height)) return;
        const db = await open();
        if (!db) return;
        await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(record));
      } catch {
        // Quota or a closed database: the cache is an optimisation.
      }
    },
  };
}
