/* @ts-self-types="./calab_cala_core.d.ts" */

/**
 * Owning wrapper over `OwnedAviReader`. Parses the RIFF container
 * once in `new`, caches the frame index, then decodes individual
 * frames directly from the held buffer without re-walking the
 * container. Safe to construct from a `File.slice()` `ArrayBuffer`
 * handed across the JS ↔ WASM boundary.
 */
export class AviReader {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AviReaderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_avireader_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    bitDepth() {
        const ret = wasm.avireader_bitDepth(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    channels() {
        const ret = wasm.avireader_channels(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    fps() {
        const ret = wasm.avireader_fps(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    frameCount() {
        const ret = wasm.avireader_frameCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    height() {
        const ret = wasm.avireader_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Parse an AVI. `bytes` is copied into WASM memory once; frame
     * reads are zero-copy slices into that owned buffer.
     * @param {Uint8Array} bytes
     */
    constructor(bytes) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.avireader_new(retptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0 >>> 0;
            AviReaderFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Decode one frame into a new `Float32Array`.
     *
     * `method` picks the 24-bit → grayscale reduction:
     * `"Green"` (default on miniscope raw) or `"Luminance"` (Rec.601).
     * Ignored for 8-bit streams.
     * @param {number} n
     * @param {string} method
     * @returns {Float32Array}
     */
    readFrameGrayscaleF32(n, method) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(method, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.avireader_readFrameGrayscaleF32(retptr, this.__wbg_ptr, n, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayF32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export(r0, r1 * 4, 4);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {number}
     */
    width() {
        const ret = wasm.avireader_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) AviReader.prototype[Symbol.dispose] = AviReader.prototype.free;

/**
 * Wraps a `ResidualRingBuf` plus the parsed `ExtendConfig` /
 * `RecordingMetadata` so the browser W3 worker can drive one
 * `extending::driver::run_cycle` per extend tick without re-parsing
 * JSON every call. The caller pushes residuals each fit frame and
 * invokes `runCycle` on whatever cadence the worker chooses
 * (design §7.2, §13 bounded-work-per-cycle).
 */
export class Extender {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ExtenderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_extender_free(ptr, 0);
    }
    /**
     * Construct an Extender. `residual_window_len` is typically
     * `ExtendConfig::extend_window_frames` but stays an explicit
     * argument so the caller can size the buffer against whatever
     * window they ship to fit without re-reading the config.
     * @param {number} height
     * @param {number} width
     * @param {number} residual_window_len
     * @param {string} extend_cfg_json
     * @param {string} metadata_json
     */
    constructor(height, width, residual_window_len, extend_cfg_json, metadata_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(extend_cfg_json, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(metadata_json, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            wasm.extender_new(retptr, height, width, residual_window_len, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0 >>> 0;
            ExtenderFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Push one residual frame (length = `height * width`). Drop-oldest
     * when the window is full.
     * @param {Float32Array} residual
     */
    pushResidual(residual) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArrayF32ToWasm0(residual, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.extender_pushResidual(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Length of the residual window that would feed the next cycle.
     * Cosmetic accessor the worker exposes as a vitals metric.
     * @returns {number}
     */
    residualLen() {
        const ret = wasm.extender_residualLen(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Run one extend cycle against `fitter`'s current state.
     * Proposals land on `queue` (drop-oldest); returns the number
     * actually pushed this call so the worker can report an
     * extend-cycle metric.
     * @param {Fitter} fitter
     * @param {MutationQueueHandle} queue
     * @returns {number}
     */
    runCycle(fitter, queue) {
        _assertClass(fitter, Fitter);
        _assertClass(queue, MutationQueueHandle);
        const ret = wasm.extender_runCycle(this.__wbg_ptr, fitter.__wbg_ptr, queue.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) Extender.prototype[Symbol.dispose] = Extender.prototype.free;

/**
 * Owning wrapper over `FitPipeline` — the per-frame OMF step. Starts
 * with an empty `Footprints` (`num_components() == 0`); the fit
 * worker grows the model by draining the `MutationQueueHandle`.
 */
export class Fitter {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FitterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fitter_free(ptr, 0);
    }
    /**
     * Drain every mutation in `queue` and apply in FIFO order. The
     * returned flat `Uint32Array` carries `[applied, stale, invalid]`
     * counts — ready to push to the archive worker for dashboard
     * metrics.
     * @param {MutationQueueHandle} queue
     * @returns {Uint32Array}
     */
    drainApply(queue) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            _assertClass(queue, MutationQueueHandle);
            wasm.fitter_drainApply(retptr, this.__wbg_ptr, queue.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Current asset epoch. Advances once per successful mutation
     * apply; not touched by per-frame `step` calls.
     * @returns {bigint}
     */
    epoch() {
        const ret = wasm.fitter_epoch(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {number}
     */
    height() {
        const ret = wasm.fitter_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Latest trace vector `c_t` (length = `num_components()`), or an
     * empty `Float32Array` before the first `step()` has landed.
     * @returns {Float32Array}
     */
    lastTrace() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.fitter_lastTrace(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Construct a fitter for a fixed-shape frame stream.
     *
     * `cfg_json` parses against `FitConfig`'s serde shape. `"{}"`
     * means every `DEFAULT_*` value applies.
     * @param {number} height
     * @param {number} width
     * @param {string} cfg_json
     */
    constructor(height, width, cfg_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(cfg_json, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.fitter_new(retptr, height, width, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0 >>> 0;
            FitterFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Number of live components in `Ã`.
     * @returns {number}
     */
    numComponents() {
        const ret = wasm.fitter_numComponents(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Run one OMF frame. Returns the residual `R_t` as a new
     * `Float32Array` so the extend worker can read it.
     * @param {Float32Array} y
     * @returns {Float32Array}
     */
    step(y) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArrayF32ToWasm0(y, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.fitter_step(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayF32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export(r0, r1 * 4, 4);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Take an extend-visible snapshot of `(Ã, W, M, epoch)` — design
     * §7.2. Returned as an opaque handle; Phase 5 only surfaces
     * `epoch()` on it, full read accessors are Phase 7 extend work.
     * @returns {SnapshotHandle}
     */
    takeSnapshot() {
        const ret = wasm.fitter_takeSnapshot(this.__wbg_ptr);
        return SnapshotHandle.__wrap(ret);
    }
    /**
     * @returns {number}
     */
    width() {
        const ret = wasm.fitter_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) Fitter.prototype[Symbol.dispose] = Fitter.prototype.free;

/**
 * Opaque handle to a `MutationQueue`. Extend pushes; fit drains via
 * `Fitter::drain_apply`. Construction reads `mutation_queue_capacity`
 * from `ExtendConfig`'s JSON (default 32 per design §7.3).
 */
export class MutationQueueHandle {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MutationQueueHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_mutationqueuehandle_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    capacity() {
        const ret = wasm.mutationqueuehandle_capacity(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {bigint}
     */
    drops() {
        const ret = wasm.mutationqueuehandle_drops(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {boolean}
     */
    isEmpty() {
        const ret = wasm.mutationqueuehandle_isEmpty(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    isFull() {
        const ret = wasm.mutationqueuehandle_isFull(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    len() {
        const ret = wasm.mutationqueuehandle_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Construct a queue whose capacity comes from `extend_cfg_json`'s
     * `mutation_queue_capacity` field. JS callers pass the same JSON
     * used to build the `ExtendConfig` — single source of truth.
     * @param {string} extend_cfg_json
     */
    constructor(extend_cfg_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(extend_cfg_json, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.mutationqueuehandle_new(retptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0 >>> 0;
            MutationQueueHandleFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Enqueue a deprecate mutation. Phase 5 exposes deprecate as the
     * minimal push surface — register / merge pushes light up in
     * Phase 7 when extend actually generates them. `reason` takes
     * the serde-variant string (`"FootprintCollapsed"`, etc).
     * @param {bigint} snapshot_epoch
     * @param {number} id
     * @param {string} reason
     */
    pushDeprecate(snapshot_epoch, id, reason) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(reason, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.mutationqueuehandle_pushDeprecate(retptr, this.__wbg_ptr, snapshot_epoch, id, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) MutationQueueHandle.prototype[Symbol.dispose] = MutationQueueHandle.prototype.free;

/**
 * Owning wrapper over `PreprocessPipeline` (hot-pixel → [opt butter]
 * → [opt band] → motion → [opt denoise]). All knobs come from the
 * `cfg_json` string — see `PreprocessConfig`'s `serde` shape.
 */
export class Preprocessor {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PreprocessorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_preprocessor_free(ptr, 0);
    }
    /**
     * Construct a preprocessor.
     *
     * - `height`, `width`: frame dimensions (must match all frames
     *   pushed through `process_frame_*`).
     * - `metadata_json`: JSON matching `RecordingMetadata`'s serde
     *   shape, e.g. `{"pixel_size_um":2.0}`.
     * - `cfg_json`: JSON matching `PreprocessConfig`'s serde shape;
     *   `"{}"` applies every `DEFAULT_*` value.
     * @param {number} height
     * @param {number} width
     * @param {string} metadata_json
     * @param {string} cfg_json
     */
    constructor(height, width, metadata_json, cfg_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(metadata_json, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(cfg_json, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            wasm.preprocessor_new(retptr, height, width, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0 >>> 0;
            PreprocessorFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Run one preprocess step on an `f32` grayscale frame
     * (`height × width`, row-major). Returns a new `Float32Array`
     * containing the cleaned frame.
     * @param {Float32Array} input
     * @returns {Float32Array}
     */
    processFrameF32(input) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArrayF32ToWasm0(input, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.preprocessor_processFrameF32(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayF32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export(r0, r1 * 4, 4);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Convenience: decode raw AVI bytes to grayscale and preprocess
     * in one call. Avoids a round-trip across the JS boundary for
     * the intermediate f32 buffer.
     * @param {Uint8Array} input
     * @param {number} channels
     * @param {string} method
     * @returns {Float32Array}
     */
    processFrameU8(input, channels, method) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(input, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(method, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            wasm.preprocessor_processFrameU8(retptr, this.__wbg_ptr, ptr0, len0, channels, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v3 = getArrayF32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export(r0, r1 * 4, 4);
            return v3;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Reset motion anchors. The next `process_frame_*` call behaves
     * as a first-frame (no global anchor contribution yet).
     */
    reset() {
        wasm.preprocessor_reset(this.__wbg_ptr);
    }
}
if (Symbol.dispose) Preprocessor.prototype[Symbol.dispose] = Preprocessor.prototype.free;

/**
 * Opaque handle to a `Snapshot`. Only `epoch` is surfaced in Phase 5;
 * full extend-side access lands with the real extend worker.
 */
export class SnapshotHandle {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(SnapshotHandle.prototype);
        obj.__wbg_ptr = ptr;
        SnapshotHandleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SnapshotHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_snapshothandle_free(ptr, 0);
    }
    /**
     * @returns {bigint}
     */
    epoch() {
        const ret = wasm.snapshothandle_epoch(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {number}
     */
    numComponents() {
        const ret = wasm.snapshothandle_numComponents(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    pixels() {
        const ret = wasm.snapshothandle_pixels(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) SnapshotHandle.prototype[Symbol.dispose] = SnapshotHandle.prototype.free;

/**
 * Install the console panic hook. Call once, early, from each
 * worker so `panic!` surfaces in the browser console instead of
 * appearing as a WASM trap.
 */
export function init_panic_hook() {
    wasm.init_panic_hook();
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_6b64449b9b9ed33c: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_export(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return addHeapObject(ret);
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = getObject(arg1).stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
    };
    return {
        __proto__: null,
        "./calab_cala_core_bg.js": import0,
    };
}

const AviReaderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_avireader_free(ptr >>> 0, 1));
const ExtenderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_extender_free(ptr >>> 0, 1));
const FitterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fitter_free(ptr >>> 0, 1));
const MutationQueueHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_mutationqueuehandle_free(ptr >>> 0, 1));
const PreprocessorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_preprocessor_free(ptr >>> 0, 1));
const SnapshotHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_snapshothandle_free(ptr >>> 0, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('calab_cala_core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
