/**
 * The online sensor flat field on the main thread, for the pipeline store: the setting, the
 * estimator's status and maps, and the per-device cache (`flat-field-cache.ts`).
 */
import { createSignal } from 'solid-js';
import {
  flatFieldKey,
  initialFlatFieldState,
  type DeviceIdentity,
  type FlatFieldApplied,
  type FlatFieldEvent,
  type FlatFieldKey,
  type FlatFieldMap,
  type FlatFieldState,
} from './flat-field.ts';
import {
  mapFromRecord,
  recordFromMap,
  recordFits,
  type FlatFieldCache,
  type FlatFieldRecord,
} from './flat-field-cache.ts';
import type { PipelineClient } from './frame-client.ts';
import type { RunHistory } from './run-history.ts';
import type { RunRecord } from './run-record.ts';

/** What the pipeline store needs for the per-device flat-field cache. */
export interface FlatFieldStoreOptions {
  cache?: FlatFieldCache;
  /** What the open recording says about its sensor (null before one is open). */
  identity?: () => {
    width: number;
    height: number;
    device?: DeviceIdentity;
    liveName?: string;
    /** A live stream (its maps are neither read from nor written to the cache). */
    live?: boolean;
    /** Frames in the recording (a speed curve is a share of them); absent for a stream. */
    frames?: number;
    folder: string;
  } | null;
  /** Minimum time between cache writes, ms (default one minute; the run end always writes). */
  writeIntervalMs?: number;
  /** Wall clock, ms (tests). */
  now?: () => number;
}

/** Cache writes at most this often while a run goes on. */
const FLAT_FIELD_WRITE_INTERVAL_MS = 60_000;

/** What the flat-field store reads from, and tells, the pipeline store. */
export interface FlatFieldDeps {
  client: Pick<PipelineClient, 'subscribeFlatField'>;
  /** The setting's initial value. */
  enabled: boolean;
  flat: FlatFieldStoreOptions;
  runHistory?: RunHistory;
  /** The current run's record. */
  record: () => RunRecord;
  /** No further map of this run will come (the estimator finished or failed). */
  onFinal: () => void;
  /** A new map of this run's estimator. */
  onMap: (map: FlatFieldMap) => void;
}

/** The flat field's setting, status and newest map; subscribes to the client's estimator events. */
export function createFlatFieldStore(deps: FlatFieldDeps) {
  const { client, flat, runHistory } = deps;
  const [flatEnabled, setFlatEnabledSignal] = createSignal(deps.enabled);
  const [flatField, setFlatField] = createSignal<FlatFieldState>({
    ...initialFlatFieldState(),
    supported: client.subscribeFlatField !== undefined,
  });
  const patchFlat = (p: Partial<FlatFieldState>): void => {
    setFlatField((s) => ({ ...s, ...p }));
  };
  /** The session whose estimator events count (0: none yet). */
  let flatSessionId = 0;
  let flatKey: FlatFieldKey | null = null;
  let flatDims = { width: 0, height: 0 };
  let flatLatest: FlatFieldMap | null = null;
  let flatDirty = false;
  let flatLastWrite = -Infinity;
  let flatTimer: ReturnType<typeof setTimeout> | null = null;
  const wallNow = flat.now ?? (() => Date.now());
  const writeInterval = flat.writeIntervalMs ?? FLAT_FIELD_WRITE_INTERVAL_MS;

  /** Write the newest map to the cache (never throws: the cache is an optimisation). */
  function flushFlatField(): void {
    if (flatTimer !== null) clearTimeout(flatTimer);
    flatTimer = null;
    if (!flatDirty || !flatLatest || !flatKey || !flat.cache) return;
    flatDirty = false;
    flatLastWrite = wallNow();
    void flat.cache
      .put(recordFromMap(flatKey, flatDims.width, flatDims.height, flatLatest, flatLastWrite))
      .catch(() => {});
  }

  function scheduleFlatWrite(): void {
    flatDirty = true;
    const wait = flatLastWrite + writeInterval - wallNow();
    if (wait <= 0) flushFlatField();
    else flatTimer ??= setTimeout(flushFlatField, wait);
  }

  function onFlatEvent(e: FlatFieldEvent): void {
    if (e.type === 'error') {
      // A crashed estimator (session -1) or this run's: reported, the run goes on uncorrected.
      if (e.session === -1 || e.session === flatSessionId) {
        patchFlat({ error: e.message });
        // No map of this run comes any more.
        deps.onFinal();
      }
      return;
    }
    if (e.session !== flatSessionId) return;
    switch (e.type) {
      case 'finished':
        deps.onFinal();
        return;
      case 'progress':
        patchFlat({ frames: e.frames, fps: e.fps });
        return;
      case 'skipped':
        patchFlat({ skipped: e.message });
        return;
      case 'map':
        flatLatest = e.map;
        deps.onMap(e.map);
        if (e.change) runHistory?.flatMap(e.change.median);
        setFlatField((s) => ({
          ...s,
          map: e.map,
          updates: s.updates + 1,
          lastChange: e.change,
          skipped: null,
        }));
        scheduleFlatWrite();
        return;
    }
  }
  client.subscribeFlatField?.(onFlatEvent);

  /** A flat-field map took effect at a batch boundary: keep the frame in the run record. */
  function noteApplied(applied: FlatFieldApplied): void {
    deps.record().noteFlatField(applied);
    runHistory?.log({
      frame: applied.frame,
      kind: 'flatfield',
      detail: applied.first ? 'Flat field on' : `Flat-field map ${applied.seq}`,
      // The switch from uncorrected frames is what a replay must know.
      replay: applied.first,
      data: { seq: applied.seq, source: applied.source, first: applied.first },
    });
    if (applied.first) patchFlat({ firstFrame: applied.frame });
  }

  /** A run starts or stops: the newest map is written, and this run's state cleared. */
  function reset(): void {
    flushFlatField();
    flatSessionId = 0;
    flatLatest = null;
    flatDirty = false;
    setFlatField((s) => ({
      ...initialFlatFieldState(),
      supported: s.supported,
      enabled: flatEnabled(),
    }));
  }

  /**
   * Run `session` starts: whether it runs the flat field, and the cache read of this device's
   * stored map (null: nothing to read). Pass the record read to `seed` once it is in.
   */
  function begin(session: number): {
    useFlat: boolean;
    read: Promise<FlatFieldRecord | null> | null;
  } {
    const useFlat = flatEnabled() && client.subscribeFlatField !== undefined;
    flatSessionId = session;
    flatKey = null;
    const id = useFlat ? (flat.identity?.() ?? null) : null;
    // A live stream (including an auto-connected `?live=` one) neither reads nor writes
    // the cache: a stored map is never applied silently to a stream, and a stream
    // cannot overwrite a map cached for a file or device. It estimates fresh.
    if (!id || id.live) return { useFlat, read: null };
    flatKey = flatFieldKey(id);
    flatDims = { width: id.width, height: id.height };
    return { useFlat, read: flat.cache ? flat.cache.get(flatKey.key, id.width, id.height) : null };
  }

  /**
   * The stored map read for this run (`begin`), if it fits the recording, is in force from the
   * first processed frame; returns it (undefined: none).
   */
  function seed(rec: FlatFieldRecord | null): FlatFieldMap | undefined {
    const map =
      rec && recordFits(rec, flatDims.width, flatDims.height) ? mapFromRecord(rec) : undefined;
    flatLatest = map ?? null;
    patchFlat({
      enabled: flatEnabled(),
      key: flatKey,
      reused: map !== undefined,
      map: map ?? null,
    });
    return map;
  }

  return {
    flatEnabled,
    /** Turn the online flat field on or off (takes effect at the next Discover start). */
    setFlatEnabled(on: boolean): void {
      setFlatEnabledSignal(on);
      // Not mid-run: the run keeps what it started with. The panel says so.
    },
    flatField,
    /** The newest map of this run (null: none). */
    flatFieldMap: () => flatLatest,
    flushFlatField,
    noteApplied,
    reset,
    begin,
    seed,
  };
}

/** The pipeline store's flat-field store. */
export type FlatFieldStore = ReturnType<typeof createFlatFieldStore>;
