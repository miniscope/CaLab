/* @ts-self-types="./calab_solver.d.ts" */

/**
 * Constraint type for the proximal step.
 * @enum {0 | 1}
 */
export const Constraint = Object.freeze({
    /**
     * Current: max(0, z - threshold) — L1 + non-negativity.
     */
    NonNegative: 0, "0": "NonNegative",
    /**
     * InDeCa Eq. 3: clamp(z, 0, 1) — box constraint, no L1 penalty.
     */
    Box01: 1, "1": "Box01",
});

/**
 * Convolution mode for forward/adjoint operations in FISTA.
 * @enum {0 | 1}
 */
export const ConvMode = Object.freeze({
    /**
     * FFT-based O(T log T) per call — the original implementation.
     */
    Fft: 0, "0": "Fft",
    /**
     * Banded AR(2) recursion O(T) per call — faster for long traces.
     */
    BandedAR2: 1, "1": "BandedAR2",
});

/**
 * FISTA solver for calcium deconvolution.
 *
 * Minimizes (1/2)||y - K*s - b||^2 + lambda*G_dc*||s||_1 subject to s >= 0,
 * where K is the convolution matrix derived from a double-exponential kernel,
 * b is a scalar baseline estimated jointly, and G_dc = sum(K) scales lambda
 * so the sparsity slider is effective across all kernel configurations.
 *
 * Pre-allocated buffers grow but never shrink to prevent WASM memory fragmentation.
 */
export class Solver {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SolverFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_solver_free(ptr, 0);
    }
    /**
     * Apply bandpass filter to the active trace region. Returns true if filtering was applied.
     *
     * Sets `self.filtered = true` only when HP is active, because HP removes DC and
     * baseline estimation should be skipped. LP-only preserves DC, so baseline
     * estimation must still run.
     * @returns {boolean}
     */
    apply_filter() {
        const ret = wasm.solver_apply_filter(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Returns whether the solver has converged.
     * @returns {boolean}
     */
    converged() {
        const ret = wasm.solver_converged(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Serialize solver state for warm-start cache.
     * Format: [active_len (u32)] [t_fista (f64)] [iteration (u32)] [baseline (f64)] [solution f32...] [solution_prev f32...]
     * @returns {Uint8Array}
     */
    export_state() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.solver_export_state(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {boolean}
     */
    filter_enabled() {
        const ret = wasm.solver_filter_enabled(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Returns the estimated scalar baseline (EMA-smoothed for stable display).
     * Lazily computes reconvolution if stale, to ensure the EMA is up to date.
     * @returns {number}
     */
    get_baseline() {
        const ret = wasm.solver_get_baseline(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get filter cutoff frequencies as [f_hp, f_lp].
     * @returns {Float32Array}
     */
    get_filter_cutoffs() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.solver_get_filter_cutoffs(retptr, this.__wbg_ptr);
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
     * Returns a copy of the kernel.
     *
     * Returns `Vec<f32>` which wasm-bindgen copies into a JS-owned `Float32Array`.
     * A WASM memory view would be unsound here: any subsequent WASM allocation
     * (e.g. `set_trace`) can grow the memory and invalidate the view. The JS side
     * also transfers these buffers via `postMessage`, which requires ownership.
     * @returns {Float32Array}
     */
    get_kernel() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.solver_get_kernel(retptr, this.__wbg_ptr);
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
     * Get the power spectrum of the current trace (N/2+1 bins).
     * @returns {Float32Array}
     */
    get_power_spectrum() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.solver_get_power_spectrum(retptr, this.__wbg_ptr);
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
     * Returns the reconvolution (K * solution) for the active region.
     * Computes the reconvolution lazily if it is stale (not computed during iteration).
     *
     * See `get_kernel` for why this returns an owned copy rather than a memory view.
     * @returns {Float32Array}
     */
    get_reconvolution() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.solver_get_reconvolution(retptr, this.__wbg_ptr);
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
     * Returns reconvolution with baseline added: K*s + b for the active region.
     * Computes the reconvolution lazily if it is stale.
     *
     * See `get_kernel` for why this returns an owned copy rather than a memory view.
     * @returns {Float32Array}
     */
    get_reconvolution_with_baseline() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.solver_get_reconvolution_with_baseline(retptr, this.__wbg_ptr);
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
     * Returns the current solution (spike train) for the active region.
     *
     * See `get_kernel` for why this returns an owned copy rather than a memory view.
     * @returns {Float32Array}
     */
    get_solution() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.solver_get_solution(retptr, this.__wbg_ptr);
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
     * Get frequency axis in Hz for the spectrum bins.
     * @returns {Float32Array}
     */
    get_spectrum_frequencies() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.solver_get_spectrum_frequencies(retptr, this.__wbg_ptr);
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
     * Returns the current trace for the active region.
     * After apply_filter(), this contains the filtered trace.
     *
     * See `get_kernel` for why this returns an owned copy rather than a memory view.
     * @returns {Float32Array}
     */
    get_trace() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.solver_get_trace(retptr, this.__wbg_ptr);
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
     * Returns the current iteration count.
     * @returns {number}
     */
    iteration_count() {
        const ret = wasm.solver_iteration_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Load warm-start state. If state is empty or wrong size, performs cold-start (zero solution).
     * @param {Uint8Array} state
     */
    load_state(state) {
        const ptr0 = passArray8ToWasm0(state, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.solver_load_state(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Create a new Solver with default parameters.
     */
    constructor() {
        const ret = wasm.solver_new();
        this.__wbg_ptr = ret >>> 0;
        SolverFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Reset FISTA momentum. Used for warm-start after kernel change.
     * Sets t_fista = 1.0 and copies solution into solution_prev.
     */
    reset_momentum() {
        wasm.solver_reset_momentum(this.__wbg_ptr);
    }
    /**
     * Set the constraint type (NonNegative or Box01).
     * @param {Constraint} c
     */
    set_constraint(c) {
        wasm.solver_set_constraint(this.__wbg_ptr, c);
    }
    /**
     * Set the convolution mode (FFT or BandedAR2).
     * Recomputes the Lipschitz constant for the selected mode.
     * Does NOT reset solution/iteration state — warm-start is preserved.
     * @param {ConvMode} mode
     */
    set_conv_mode(mode) {
        wasm.solver_set_conv_mode(this.__wbg_ptr, mode);
    }
    /**
     * Convenience: set both HP and LP together (used by CaTune's single toggle).
     * @param {boolean} enabled
     */
    set_filter_enabled(enabled) {
        wasm.solver_set_filter_enabled(this.__wbg_ptr, enabled);
    }
    /**
     * @param {boolean} enabled
     */
    set_hp_filter_enabled(enabled) {
        wasm.solver_set_hp_filter_enabled(this.__wbg_ptr, enabled);
    }
    /**
     * @param {boolean} enabled
     */
    set_lp_filter_enabled(enabled) {
        wasm.solver_set_lp_filter_enabled(this.__wbg_ptr, enabled);
    }
    /**
     * Update solver parameters and rebuild kernel.
     * @param {number} tau_rise
     * @param {number} tau_decay
     * @param {number} lambda
     * @param {number} fs
     */
    set_params(tau_rise, tau_decay, lambda, fs) {
        wasm.solver_set_params(this.__wbg_ptr, tau_rise, tau_decay, lambda, fs);
    }
    /**
     * Load a trace for deconvolution. Grows buffers if needed (never shrinks).
     * Resets iteration state for a fresh solve.
     * @param {Float32Array} trace
     */
    set_trace(trace) {
        const ptr0 = passArrayF32ToWasm0(trace, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.solver_set_trace(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Run n_steps of FISTA iterations. Returns true if converged.
     *
     * Uses the standard Beck & Teboulle FISTA with two sequences:
     * - x_k (solution): the proximal update point
     * - y_k (solution_prev used as extrapolated point): where gradient is evaluated
     *
     * The algorithm evaluates the gradient at the extrapolated point y_k, takes
     * the proximal step to get x_{k+1}, then extrapolates to get y_{k+1}.
     *
     * Includes adaptive restart (O'Donoghue & Candes 2015): when the gradient-mapping
     * criterion detects momentum is hurting progress, reset to avoid oscillation.
     *
     * Uses FFT-based O(n log n) convolutions instead of time-domain O(n*k), and
     * primal residual convergence criterion to eliminate one convolution per iteration.
     * @param {number} n_steps
     * @returns {boolean}
     */
    step_batch(n_steps) {
        const ret = wasm.solver_step_batch(this.__wbg_ptr, n_steps);
        return ret !== 0;
    }
}
if (Symbol.dispose) Solver.prototype[Symbol.dispose] = Solver.prototype.free;

/**
 * Compute the upsample factor for a given sampling rate and target rate.
 * @param {number} fs
 * @param {number} target_fs
 * @returns {number}
 */
export function indeca_compute_upsample_factor(fs, target_fs) {
    const ret = wasm.indeca_compute_upsample_factor(fs, target_fs);
    return ret >>> 0;
}

/**
 * Estimate a free-form kernel from multiple traces and their spike trains.
 *
 * `warm_kernel`: optional kernel from a previous iteration. Pass an empty slice
 * for cold-start.
 *
 * Returns the estimated kernel as Float32Array (via Vec<f32>).
 * @param {Float32Array} traces_flat
 * @param {Float32Array} spikes_flat
 * @param {Uint32Array} trace_lengths
 * @param {Float64Array} alphas
 * @param {Float64Array} baselines
 * @param {number} kernel_length
 * @param {number} max_iters
 * @param {number} tol
 * @param {Float32Array} warm_kernel
 * @returns {Float32Array}
 */
export function indeca_estimate_kernel(traces_flat, spikes_flat, trace_lengths, alphas, baselines, kernel_length, max_iters, tol, warm_kernel) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF32ToWasm0(traces_flat, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(spikes_flat, wasm.__wbindgen_export2);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(trace_lengths, wasm.__wbindgen_export2);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(alphas, wasm.__wbindgen_export2);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArrayF64ToWasm0(baselines, wasm.__wbindgen_export2);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArrayF32ToWasm0(warm_kernel, wasm.__wbindgen_export2);
        const len5 = WASM_VECTOR_LEN;
        wasm.indeca_estimate_kernel(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, kernel_length, max_iters, tol, ptr5, len5);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v7 = getArrayF32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export(r0, r1 * 4, 4);
        return v7;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Fit a bi-exponential model to a free-form kernel.
 *
 * Returns a JsValue containing the serialized BiexpResult:
 * { tau_rise, tau_decay, beta, residual }
 * @param {Float32Array} h_free
 * @param {number} fs
 * @param {boolean} refine
 * @returns {any}
 */
export function indeca_fit_biexponential(h_free, fs, refine) {
    const ptr0 = passArrayF32ToWasm0(h_free, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.indeca_fit_biexponential(ptr0, len0, fs, refine);
    return takeObject(ret);
}

/**
 * Solve a single trace using the InDeCa pipeline.
 *
 * `warm_counts`: optional spike counts from a previous iteration at the original
 * sampling rate. Pass an empty slice for cold-start.
 *
 * Returns a JsValue containing the serialized InDecaResult:
 * { s_counts, alpha, baseline, threshold, pve, iterations, converged }
 * @param {Float32Array} trace
 * @param {number} tau_r
 * @param {number} tau_d
 * @param {number} fs
 * @param {number} upsample_factor
 * @param {number} max_iters
 * @param {number} tol
 * @param {boolean} hp_enabled
 * @param {boolean} lp_enabled
 * @param {Float32Array} warm_counts
 * @returns {any}
 */
export function indeca_solve_trace(trace, tau_r, tau_d, fs, upsample_factor, max_iters, tol, hp_enabled, lp_enabled, warm_counts) {
    const ptr0 = passArrayF32ToWasm0(trace, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(warm_counts, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.indeca_solve_trace(ptr0, len0, tau_r, tau_d, fs, upsample_factor, max_iters, tol, hp_enabled, lp_enabled, ptr1, len1);
    return takeObject(ret);
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_be289d5034ed271b: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_7534b8e9a36f1ab4: function(arg0, arg1) {
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
        __wbg_new_361308b2356cecd0: function() {
            const ret = new Object();
            return addHeapObject(ret);
        },
        __wbg_new_3eb36ae241fe6f44: function() {
            const ret = new Array();
            return addHeapObject(ret);
        },
        __wbg_new_8a6f238a6ece86ea: function() {
            const ret = new Error();
            return addHeapObject(ret);
        },
        __wbg_set_3f1d0b984ed272ed: function(arg0, arg1, arg2) {
            getObject(arg0)[takeObject(arg1)] = takeObject(arg2);
        },
        __wbg_set_f43e577aea94465b: function(arg0, arg1, arg2) {
            getObject(arg0)[arg1 >>> 0] = takeObject(arg2);
        },
        __wbg_stack_0ed75d68575b0f3c: function(arg0, arg1) {
            const ret = getObject(arg1).stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return addHeapObject(ret);
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_object_clone_ref: function(arg0) {
            const ret = getObject(arg0);
            return addHeapObject(ret);
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
    };
    return {
        __proto__: null,
        "./calab_solver_bg.js": import0,
    };
}

const SolverFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_solver_free(ptr >>> 0, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 132) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
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

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
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

let heap = new Array(128).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

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

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
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
    cachedFloat64ArrayMemory0 = null;
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
        module_or_path = new URL('calab_solver_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
