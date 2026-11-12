/**
 * The online sensor flat field, shared types and pure helpers.
 *
 * Sensor pixel gain (PRNU plus column structure) is fixed to the sensor while
 * registration moves the tissue over it, so motion-correlated traces pick it
 * up as footprint texture. A gain map estimated from the recording's own
 * motion dither (`FlatFieldEstimator`, in a worker of its own) is divided out
 * of the raw frames in stage A of the pipeline. See `flat-field-runner.ts`
 * (the estimator driver) and `pipeline-stages.ts` (where the map is applied).
 */

/** Seconds of frames before the first map (the library default, shown in the UI). */
export const FLAT_FIELD_FIRST_S = 150;
/** Seconds of frames between refinements (the library default). */
export const FLAT_FIELD_REFINE_S = 60;
/** Gain range shown as black..white in the UI (fixed: no auto-contrast). */
export const FLAT_FIELD_DISPLAY_RANGE: readonly [number, number] = [0.9, 1.1];
/** Batches the estimator may have in flight before stage A drops frames for it. */
export const FLAT_FIELD_MAX_QUEUE = 4;

/** A gain map and what is known about it. */
export interface FlatFieldMap {
  /** Per-pixel gain, 1 = nominal (`width * height`). */
  gain: Float32Array;
  /** Per-pixel dark offset (empty: no offset model). */
  offset: Float32Array;
  /** Dark level added back after the correction. */
  dark: number;
  /** Shift bins and effective frames behind the map. */
  binsUsed: number;
  framesUsed: number;
  /** SD of the log gain inside the FOV (0.05 = 5%). */
  gainSd: number;
}

/** How far an update moved the corrected mean image, in noise sigma. */
export interface FlatFieldChange {
  median: number;
  p99: number;
  max: number;
}

/** Where a map in force came from. */
export type FlatFieldSource = 'cache' | 'estimate' | 'replay';

/** A map taking effect: reported with the first batch processed with it. */
export interface FlatFieldApplied {
  /** Stream frame index of the batch it took effect at (0 for a map in force from the start). */
  frame: number;
  /** Which map: the estimator's update counter (0 for a seed or replay map). */
  seq: number;
  source: FlatFieldSource;
  /** The switch from uncorrected frames to corrected ones (once per run). */
  first: boolean;
}

/** Estimator -> main thread. */
export type FlatFieldEvent =
  | { type: 'progress'; session: number; frames: number; fps: number }
  | {
      type: 'map';
      session: number;
      seq: number;
      map: FlatFieldMap;
      change: FlatFieldChange | null;
    }
  | { type: 'skipped'; session: number; message: string }
  | { type: 'error'; session: number; message: string };

// ---------------------------------------------------------------------------
// Device identity and cache key
// ---------------------------------------------------------------------------

/** What the recording says about its sensor (Miniscope `metaData.json` or a live hello). */
export interface DeviceIdentity {
  /** A serial-like identifier of the physical sensor (`serial`, `serialNumber`, ...). */
  serial?: string;
  deviceType?: string;
  deviceName?: string;
  /** Miniscope `deviceID`: the camera index on the DAQ, NOT unique to a sensor. */
  deviceId?: string;
}

export type FlatFieldKeySource = 'device' | 'live-name' | 'folder';

export interface FlatFieldKey {
  key: string;
  source: FlatFieldKeySource;
  /** One line for the UI. */
  description: string;
}

/**
 * The per-device cache key. A map is only valid for the sensor it was
 * measured on, so the key must name the physical sensor:
 *
 * - a serial-like field from the metadata or live hello: `device:<serial>|WxH`;
 * - else a live source's name: `live:<name>|WxH`;
 * - else the recording folder (`folder:<name>|<device type>|WxH`): Miniscope
 *   `metaData.json` carries `deviceType` / `deviceName` / `deviceID`, but those
 *   are the scope model, a default name and the camera index (1 on every
 *   single-scope rig), so two different sensors would share a key. The folder
 *   fallback reuses a map only when the same folder is opened again.
 *
 * Dimensions are always part of the key (a different ROI is a different map).
 */
export function flatFieldKey(args: {
  width: number;
  height: number;
  device?: DeviceIdentity;
  /** A live source's name, if it sent one. */
  liveName?: string;
  /** The opened folder's name (the viewer label). */
  folder: string;
}): FlatFieldKey {
  const dims = `${args.width}x${args.height}`;
  const serial = args.device?.serial?.trim();
  if (serial) {
    return { key: `device:${serial}|${dims}`, source: 'device', description: `device ${serial}` };
  }
  const live = args.liveName?.trim();
  if (live) {
    return { key: `live:${live}|${dims}`, source: 'live-name', description: `live source ${live}` };
  }
  const type = args.device?.deviceType?.trim() ?? '';
  return {
    key: `folder:${args.folder}|${type}|${dims}`,
    source: 'folder',
    description: `folder ${args.folder} (no device serial in the metadata)`,
  };
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

/** Everything the status line needs (kept by the pipeline store). */
export interface FlatFieldState {
  /** The estimator exists on this client (pipelined workers). */
  supported: boolean;
  /** The user's setting for the current run. */
  enabled: boolean;
  /** A stored map seeded this run. */
  reused: boolean;
  /** Frames the estimator has received and the frame rate (for the progress). */
  frames: number;
  fps: number;
  /** Maps the estimator produced this run. */
  updates: number;
  map: FlatFieldMap | null;
  lastChange: FlatFieldChange | null;
  /** Why the last refinement was skipped (null: it was not, or a later one succeeded). */
  skipped: string | null;
  /** The cache key in use (for the `reused` line). */
  key: FlatFieldKey | null;
  /** Frame where the first map took effect (null: not yet). */
  firstFrame: number | null;
  error: string | null;
}

export function initialFlatFieldState(): FlatFieldState {
  return {
    supported: false,
    enabled: true,
    reused: false,
    frames: 0,
    fps: 0,
    updates: 0,
    map: null,
    lastChange: null,
    skipped: null,
    key: null,
    firstFrame: null,
    error: null,
  };
}

/** The status line of the flat field panel. */
export function flatFieldStatusLine(s: FlatFieldState): string {
  if (!s.enabled) return 'off';
  if (!s.supported) return 'off: needs the pipelined workers (not available with ?pipeline=0)';
  if (s.error) return `error: ${s.error}`;
  const reason = s.skipped?.split(':')[0];
  if (s.skipped) {
    return s.map
      ? `skipped: ${reason} (keeping the previous map)`
      : `skipped: ${reason} (still estimating)`;
  }
  if (!s.map) {
    const k = s.fps > 0 ? s.frames / s.fps : 0;
    return `estimating (${Math.floor(k)} / ${FLAT_FIELD_FIRST_S} s of frames)`;
  }
  if (s.reused) {
    return s.updates > 0
      ? `reused + refined (${s.key?.description ?? 'stored map'})`
      : `reused from this browser${s.key ? ` (device key ${s.key.key})` : ''}`;
  }
  return `estimated (${s.map.binsUsed} shift bins, ${Math.round(s.map.framesUsed)} frames, gain SD ${(100 * s.map.gainSd).toFixed(1)}%)`;
}

/** `median 0.07 sigma, p99 0.33 sigma` for the last update, or null before one. */
export function flatFieldChangeLine(c: FlatFieldChange | null): string | null {
  if (!c || !Number.isFinite(c.median)) return null;
  return `median ${c.median.toFixed(2)} sigma, p99 ${c.p99.toFixed(2)} sigma`;
}

/** Gain -> 8-bit grey at the fixed display range (0.9 black .. 1.1 white). */
export function gainToGray8(gain: ArrayLike<number>): Uint8ClampedArray {
  const [lo, hi] = FLAT_FIELD_DISPLAY_RANGE;
  const out = new Uint8ClampedArray(gain.length);
  for (let i = 0; i < gain.length; i++) {
    const t = (gain[i] - lo) / (hi - lo);
    out[i] = Number.isFinite(t) ? Math.round(255 * Math.min(1, Math.max(0, t))) : 0;
  }
  return out;
}
