/* tslint:disable */
/* eslint-disable */

/**
 * Owning wrapper over `OwnedAviReader`. Parses the RIFF container
 * once in `new`, caches the frame index, then decodes individual
 * frames directly from the held buffer without re-walking the
 * container. Safe to construct from a `File.slice()` `ArrayBuffer`
 * handed across the JS ↔ WASM boundary.
 */
export class AviReader {
    free(): void;
    [Symbol.dispose](): void;
    bitDepth(): number;
    channels(): number;
    fps(): number;
    frameCount(): number;
    height(): number;
    /**
     * Parse an AVI. `bytes` is copied into WASM memory once; frame
     * reads are zero-copy slices into that owned buffer.
     */
    constructor(bytes: Uint8Array);
    /**
     * Decode one frame into a new `Float32Array`.
     *
     * `method` picks the 24-bit → grayscale reduction:
     * `"Green"` (default on miniscope raw) or `"Luminance"` (Rec.601).
     * Ignored for 8-bit streams.
     */
    readFrameGrayscaleF32(n: number, method: string): Float32Array;
    width(): number;
}

/**
 * Wraps a `ResidualRingBuf` plus the parsed `ExtendConfig` /
 * `RecordingMetadata` so the browser W3 worker can drive one
 * `extending::driver::run_cycle` per extend tick without re-parsing
 * JSON every call. The caller pushes residuals each fit frame and
 * invokes `runCycle` on whatever cadence the worker chooses
 * (design §7.2, §13 bounded-work-per-cycle).
 */
export class Extender {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Construct an Extender. `residual_window_len` is typically
     * `ExtendConfig::extend_window_frames` but stays an explicit
     * argument so the caller can size the buffer against whatever
     * window they ship to fit without re-reading the config.
     */
    constructor(height: number, width: number, residual_window_len: number, extend_cfg_json: string, metadata_json: string);
    /**
     * Push one residual frame (length = `height * width`). Drop-oldest
     * when the window is full.
     */
    pushResidual(residual: Float32Array): void;
    /**
     * Length of the residual window that would feed the next cycle.
     * Cosmetic accessor the worker exposes as a vitals metric.
     */
    residualLen(): number;
    /**
     * Run one extend cycle against `fitter`'s current state.
     * Proposals land on `queue` (drop-oldest); returns the number
     * actually pushed this call so the worker can report an
     * extend-cycle metric.
     */
    runCycle(fitter: Fitter, queue: MutationQueueHandle): number;
}

/**
 * Owning wrapper over `FitPipeline` — the per-frame OMF step. Starts
 * with an empty `Footprints` (`num_components() == 0`); the fit
 * worker grows the model by draining the `MutationQueueHandle`.
 */
export class Fitter {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Drain every mutation in `queue` and apply in FIFO order. The
     * returned flat `Uint32Array` carries `[applied, stale, invalid]`
     * counts — ready to push to the archive worker for dashboard
     * metrics.
     */
    drainApply(queue: MutationQueueHandle): Uint32Array;
    /**
     * Current asset epoch. Advances once per successful mutation
     * apply; not touched by per-frame `step` calls.
     */
    epoch(): bigint;
    height(): number;
    /**
     * Latest trace vector `c_t` (length = `num_components()`), or an
     * empty `Float32Array` before the first `step()` has landed.
     */
    lastTrace(): Float32Array;
    /**
     * Construct a fitter for a fixed-shape frame stream.
     *
     * `cfg_json` parses against `FitConfig`'s serde shape. `"{}"`
     * means every `DEFAULT_*` value applies.
     */
    constructor(height: number, width: number, cfg_json: string);
    /**
     * Number of live components in `Ã`.
     */
    numComponents(): number;
    /**
     * Run one OMF frame. Returns the residual `R_t` as a new
     * `Float32Array` so the extend worker can read it.
     */
    step(y: Float32Array): Float32Array;
    /**
     * Take an extend-visible snapshot of `(Ã, W, M, epoch)` — design
     * §7.2. Returned as an opaque handle; Phase 5 only surfaces
     * `epoch()` on it, full read accessors are Phase 7 extend work.
     */
    takeSnapshot(): SnapshotHandle;
    width(): number;
}

/**
 * Opaque handle to a `MutationQueue`. Extend pushes; fit drains via
 * `Fitter::drain_apply`. Construction reads `mutation_queue_capacity`
 * from `ExtendConfig`'s JSON (default 32 per design §7.3).
 */
export class MutationQueueHandle {
    free(): void;
    [Symbol.dispose](): void;
    capacity(): number;
    drops(): bigint;
    isEmpty(): boolean;
    isFull(): boolean;
    len(): number;
    /**
     * Construct a queue whose capacity comes from `extend_cfg_json`'s
     * `mutation_queue_capacity` field. JS callers pass the same JSON
     * used to build the `ExtendConfig` — single source of truth.
     */
    constructor(extend_cfg_json: string);
    /**
     * Enqueue a deprecate mutation. Phase 5 exposes deprecate as the
     * minimal push surface — register / merge pushes light up in
     * Phase 7 when extend actually generates them. `reason` takes
     * the serde-variant string (`"FootprintCollapsed"`, etc).
     */
    pushDeprecate(snapshot_epoch: bigint, id: number, reason: string): void;
}

/**
 * Owning wrapper over `PreprocessPipeline` (hot-pixel → [opt butter]
 * → [opt band] → motion → [opt denoise]). All knobs come from the
 * `cfg_json` string — see `PreprocessConfig`'s `serde` shape.
 */
export class Preprocessor {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Construct a preprocessor.
     *
     * - `height`, `width`: frame dimensions (must match all frames
     *   pushed through `process_frame_*`).
     * - `metadata_json`: JSON matching `RecordingMetadata`'s serde
     *   shape, e.g. `{"pixel_size_um":2.0}`.
     * - `cfg_json`: JSON matching `PreprocessConfig`'s serde shape;
     *   `"{}"` applies every `DEFAULT_*` value.
     */
    constructor(height: number, width: number, metadata_json: string, cfg_json: string);
    /**
     * Run one preprocess step on an `f32` grayscale frame
     * (`height × width`, row-major). Returns a new `Float32Array`
     * containing the cleaned frame.
     */
    processFrameF32(input: Float32Array): Float32Array;
    /**
     * Convenience: decode raw AVI bytes to grayscale and preprocess
     * in one call. Avoids a round-trip across the JS boundary for
     * the intermediate f32 buffer.
     */
    processFrameU8(input: Uint8Array, channels: number, method: string): Float32Array;
    /**
     * Reset motion anchors. The next `process_frame_*` call behaves
     * as a first-frame (no global anchor contribution yet).
     */
    reset(): void;
}

/**
 * Opaque handle to a `Snapshot`. Only `epoch` is surfaced in Phase 5;
 * full extend-side access lands with the real extend worker.
 */
export class SnapshotHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    epoch(): bigint;
    numComponents(): number;
    pixels(): number;
}

/**
 * Install the console panic hook. Call once, early, from each
 * worker so `panic!` surfaces in the browser console instead of
 * appearing as a WASM trap.
 */
export function init_panic_hook(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_avireader_free: (a: number, b: number) => void;
    readonly __wbg_extender_free: (a: number, b: number) => void;
    readonly __wbg_fitter_free: (a: number, b: number) => void;
    readonly __wbg_mutationqueuehandle_free: (a: number, b: number) => void;
    readonly __wbg_preprocessor_free: (a: number, b: number) => void;
    readonly __wbg_snapshothandle_free: (a: number, b: number) => void;
    readonly avireader_bitDepth: (a: number) => number;
    readonly avireader_channels: (a: number) => number;
    readonly avireader_fps: (a: number) => number;
    readonly avireader_frameCount: (a: number) => number;
    readonly avireader_height: (a: number) => number;
    readonly avireader_new: (a: number, b: number, c: number) => void;
    readonly avireader_readFrameGrayscaleF32: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly avireader_width: (a: number) => number;
    readonly extender_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly extender_pushResidual: (a: number, b: number, c: number, d: number) => void;
    readonly extender_runCycle: (a: number, b: number, c: number) => number;
    readonly fitter_drainApply: (a: number, b: number, c: number) => void;
    readonly fitter_epoch: (a: number) => bigint;
    readonly fitter_height: (a: number) => number;
    readonly fitter_lastTrace: (a: number, b: number) => void;
    readonly fitter_new: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly fitter_numComponents: (a: number) => number;
    readonly fitter_step: (a: number, b: number, c: number, d: number) => void;
    readonly fitter_takeSnapshot: (a: number) => number;
    readonly fitter_width: (a: number) => number;
    readonly mutationqueuehandle_capacity: (a: number) => number;
    readonly mutationqueuehandle_drops: (a: number) => bigint;
    readonly mutationqueuehandle_isEmpty: (a: number) => number;
    readonly mutationqueuehandle_isFull: (a: number) => number;
    readonly mutationqueuehandle_len: (a: number) => number;
    readonly mutationqueuehandle_new: (a: number, b: number, c: number) => void;
    readonly mutationqueuehandle_pushDeprecate: (a: number, b: number, c: bigint, d: number, e: number, f: number) => void;
    readonly preprocessor_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly preprocessor_processFrameF32: (a: number, b: number, c: number, d: number) => void;
    readonly preprocessor_processFrameU8: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly preprocessor_reset: (a: number) => void;
    readonly snapshothandle_epoch: (a: number) => bigint;
    readonly snapshothandle_numComponents: (a: number) => number;
    readonly snapshothandle_pixels: (a: number) => number;
    readonly init_panic_hook: () => void;
    readonly extender_residualLen: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
