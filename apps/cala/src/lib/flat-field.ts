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
  | {
      type: 'progress';
      session: number;
      frames: number;
      fps: number;
      /** Frames before the first map (the run's `flat_field.first_map_s`). */
      firstFrames: number;
    }
  | {
      type: 'map';
      session: number;
      seq: number;
      map: FlatFieldMap;
      change: FlatFieldChange | null;
    }
  | { type: 'skipped'; session: number; message: string }
  | { type: 'error'; session: number; message: string }
  /**
   * The recording ended and every batch sent was taken in: no map of this
   * session comes after this one (`FlatFieldDown` `finish`).
   */
  | { type: 'finished'; session: number };

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

/** Where a flat-field cache key came from (see `flatFieldKey`). */
export type FlatFieldKeySource = 'device' | 'live-device' | 'live-name' | 'folder';

/** A flat-field cache key and how it was derived. */
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
  /** The source is a live stream: its keys live in their own namespace (`live-device:`, `live:`). */
  live?: boolean;
  /** The opened folder's name (the viewer label). */
  folder: string;
}): FlatFieldKey {
  const dims = `${args.width}x${args.height}`;
  const serial = args.device?.serial?.trim();
  if (serial && args.live) {
    return {
      key: `live-device:${serial}|${dims}`,
      source: 'live-device',
      description: `live device ${serial}`,
    };
  }
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
  /** The client has a flat-field estimator worker (`PipelineClient.subscribeFlatField`). */
  supported: boolean;
  /** The user's setting for the current run. */
  enabled: boolean;
  /** A stored map seeded this run. */
  reused: boolean;
  /** Frames the estimator has received, the frame rate and the frames before the first map (for the progress). */
  frames: number;
  fps: number;
  firstFrames: number;
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

/** The status before any run: enabled, no estimator, no map. */
export function initialFlatFieldState(): FlatFieldState {
  return {
    supported: false,
    enabled: true,
    reused: false,
    frames: 0,
    fps: 0,
    firstFrames: 0,
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
  if (!s.supported) return 'off: no flat-field estimator';
  if (s.error) return `error: ${s.error}`;
  const reason = s.skipped?.split(':')[0];
  if (s.skipped) {
    return s.map
      ? `skipped: ${reason} (keeping the previous map)`
      : `skipped: ${reason} (still estimating)`;
  }
  if (!s.map) {
    const k = flatFieldSeconds(s);
    return `estimating (${Math.floor(k)} / ${Math.round(flatFieldFirstSeconds(s))} s of frames)`;
  }
  if (s.reused) {
    return s.updates > 0
      ? `reused + refined (${s.key?.description ?? 'stored map'})`
      : `reused from this browser${s.key ? ` (device key ${s.key.key})` : ''}`;
  }
  return `estimated (${s.map.binsUsed} shift bins, ${Math.round(s.map.framesUsed)} frames, gain SD ${(100 * s.map.gainSd).toFixed(1)}%)`;
}

/** The flat field's state as a short word and its colour role (the panel's badge). */
export interface FlatFieldBadge {
  label: string;
  tone: 'neutral' | 'ok' | 'warning' | 'critical';
  /** True while the first map is still being estimated (the panel shows its progress). */
  estimating: boolean;
}

/** Badge of the flat field panel; the same precedence as `flatFieldStatusLine`. */
export function flatFieldBadge(s: FlatFieldState): FlatFieldBadge {
  if (!s.enabled) return { label: 'Off', tone: 'neutral', estimating: false };
  if (!s.supported) return { label: 'No estimator', tone: 'neutral', estimating: false };
  if (s.error) return { label: 'Error', tone: 'critical', estimating: false };
  if (s.skipped) return { label: 'Skipped', tone: 'warning', estimating: !s.map };
  if (!s.map) return { label: 'Estimating', tone: 'neutral', estimating: true };
  if (s.reused) {
    return { label: s.updates > 0 ? 'Reused + refined' : 'Reused', tone: 'ok', estimating: false };
  }
  return { label: 'Estimated', tone: 'ok', estimating: false };
}

/** Seconds of frames the estimator has received (0 before the frame rate is known). */
export function flatFieldSeconds(s: Pick<FlatFieldState, 'frames' | 'fps'>): number {
  return s.fps > 0 ? s.frames / s.fps : 0;
}

/** Seconds of frames before the first map (0 before the estimator's first report). */
export function flatFieldFirstSeconds(s: Pick<FlatFieldState, 'firstFrames' | 'fps'>): number {
  return s.fps > 0 ? s.firstFrames / s.fps : 0;
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
