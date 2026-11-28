/**
 * A run's params (`CalaParams`, `src/params`): the one place the app turns its settings into a
 * params layer, and the resolved params every worker builds its engine objects from.
 *
 * The frame worker resolves the layer once per run against the recording (`resolveRunParams`,
 * in `FrontStage`); the resolved JSON (`ResolvedParams.toJson`, `crates/cala/src/params/js.rs`)
 * then travels in every worker's init message, and each worker rebuilds its wasm handle from it
 * (`params-handle.ts`). TS code reads engine values from its `engine` view, never from copies.
 */
import type {
  CalaParams,
  ClusterUpdate,
  FinalSettleLevel,
  Flicker,
  VisitMode,
} from '../params/cala-params.d.ts';
import { schemaDefaults } from '../params/schema.ts';
import { ASSUMED_FPS } from './miniscope-meta.ts';

/** Any subset of `T`'s keys, at any depth. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object | null ? DeepPartial<T[K]> | null : T[K];
};

/** `settle.background.cap`'s choices. */
export type BackgroundCap = CalaParams['settle']['background']['cap'];

/** True for a value `settle.background.cap` takes. */
export function isBackgroundCap(v: number): v is BackgroundCap {
  return v === 0 || v === 0.5 || v === 1 || v === 2;
}

/** A partial params object: the keys it leaves out keep their default. */
export type ParamsLayer = DeepPartial<CalaParams>;

/** What a Discover start's settings say about the params. */
export interface RunParamsSettings {
  /**
   * Look-back for this run (`lookback.enabled`). Off, Discover's slow loop also runs without the
   * cluster history replay and the merge guard (`discover.cluster.update`,
   * `discover.merge.guard_min_sep_d`): those are the options look-back is validated with.
   */
  lookback: boolean;
  /**
   * A live stream's Final settle on factors (never with look-back): the slow loop runs the
   * cluster replay and merge guard of `settle.on_factors`, which act in refine-scope visits only.
   */
  factorSettle: boolean;
  /** The Discover visit rate's schedule (`discover.visit.mode`). */
  visitMode: VisitMode;
  /** The online sensor flat field (`flat_field.enabled`). */
  flatField: boolean;
  /** The Final settle's level (`settle.final.level`). */
  finalSettleLevel?: FinalSettleLevel;
  /** Find new cells (`stages.find_new_cells`; absent: the default). */
  findNewCells?: boolean;
  /**
   * Extract after Discover (`stages.extract`; absent: the default, on). Off: the run stops
   * after Discover and writes the footprints with Discover's traces.
   */
  extract?: boolean;
  /** Online QC of the traces (`qc.enabled`; absent: the default). */
  qc?: boolean;
  /** A repeatable run (`compute.repeatable`; absent: the default). */
  repeatable?: boolean;
  /** Background settle's cap (`settle.background.cap`; absent: the default). */
  settleCap?: BackgroundCap;
  /** Global flicker correction (`preprocess.flicker`; absent: the default). */
  flicker?: Flicker;
  /** A layer under the settings (absent: none): its keys apply unless a setting sets them. */
  base?: ParamsLayer;
}

/** `layer` over `base`, key by key: objects merge, everything else replaces. */
export function mergeLayers(base: ParamsLayer, layer: ParamsLayer): ParamsLayer {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(layer as Record<string, unknown>)) {
    const b = out[k];
    out[k] =
      isObject(v) && isObject(b) ? mergeLayers(b as ParamsLayer, v as ParamsLayer) : (v as unknown);
  }
  return out as ParamsLayer;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The params layer of a Discover start: the settings over `s.base`. */
export function runParamsLayer(s: RunParamsSettings): ParamsLayer {
  const onFactors = schemaDefaults().settle.on_factors;
  const replay: { update: ClusterUpdate; guard: number | null } | null = s.lookback
    ? null
    : s.factorSettle
      ? { update: onFactors.cluster_update, guard: onFactors.guard_min_sep_d ?? null }
      : { update: 'off', guard: null };
  const settings: ParamsLayer = {
    lookback: { enabled: s.lookback },
    discover: {
      visit: { mode: s.visitMode },
      ...(replay
        ? { cluster: { update: replay.update }, merge: { guard_min_sep_d: replay.guard } }
        : {}),
    },
    flat_field: { enabled: s.flatField },
    ...(s.finalSettleLevel || s.settleCap !== undefined
      ? {
          settle: {
            ...(s.finalSettleLevel ? { final: { level: s.finalSettleLevel } } : {}),
            ...(s.settleCap !== undefined ? { background: { cap: s.settleCap } } : {}),
          },
        }
      : {}),
    ...(s.findNewCells !== undefined || s.extract !== undefined
      ? {
          stages: {
            ...(s.findNewCells !== undefined ? { find_new_cells: s.findNewCells } : {}),
            ...(s.extract !== undefined ? { extract: s.extract } : {}),
          },
        }
      : {}),
    ...(s.qc !== undefined ? { qc: { enabled: s.qc } } : {}),
    ...(s.repeatable !== undefined ? { compute: { repeatable: s.repeatable } } : {}),
    ...(s.flicker ? { preprocess: { flicker: s.flicker } } : {}),
  };
  return mergeLayers(s.base ?? {}, settings);
}

/** What `resolveParams` needs of the recording. */
export interface ParamsContext {
  /** Frames per second: the recording's, or `ASSUMED_FPS` when it has none. */
  fps: number;
  /** Frame width and height, px. */
  frame: [number, number];
}

/** The recording's context: its frame rate when it has one, else the declared fallback. */
export function paramsContext(info: {
  fps?: number | null;
  width: number;
  height: number;
}): ParamsContext {
  const fps =
    typeof info.fps === 'number' && Number.isFinite(info.fps) && info.fps > 0
      ? info.fps
      : ASSUMED_FPS;
  return { fps, frame: [info.width, info.height] };
}

/**
 * The fields of the engine view (`params::resolve::EngineView`: every engine value the params
 * set, in frames and pixels) that the app's TS reads.
 */
export interface EngineView {
  /** The frame rate in force, Hz. */
  fps: number;
  frame: [number, number];
  /** The cell diameter in force: from `scales.cell_diameter_px` (`px`) or from µm through the optics. */
  cell_diameter: { px: number; source: 'px' | 'optics'; um_per_px: number | null };
  preprocess: { warmup_frames: number; flatten_cell_diameter_px: number };
  motion: { warmup_frames: number; session_fix: boolean };
  flat_field: { enabled: boolean; first_frames: number; refine_every_frames: number };
  slow_loop: {
    cell_diameter_px: number;
    budget: number;
    joint_update: ClusterUpdate;
    joint_sign_rule: string;
    merge_guard_min_sep: number | null;
  };
  visit: { auto: boolean; target: number };
  lookback: { enabled: boolean; rate: number; max_frames: number };
  settle: { final_max_frames: number };
  qc: { enabled: boolean; min_snr: number; pair_r: number; motion_r2_flag: number };
  factors: { window_frames: number };
}

/** A run's resolved params: `ResolvedParams.toJson`'s text and what it holds. */
export interface RunParams {
  /** The text every worker init carries (`ResolvedParams.fromJson` rebuilds the handle). */
  json: string;
  params: CalaParams;
  context: ParamsContext;
  /** SHA-256 of the params' results fields, hex. */
  fingerprint: string;
  engine: EngineView;
}

/** Parse the resolved params' text. */
export function runParams(json: string): RunParams {
  const v = JSON.parse(json) as Omit<RunParams, 'json'>;
  return {
    json,
    params: v.params,
    context: v.context,
    fingerprint: v.fingerprint,
    engine: v.engine,
  };
}
