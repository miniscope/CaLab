/* tslint:disable */
/* eslint-disable */

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
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Apply bandpass filter to the active trace region. Returns true if filtering was applied.
     */
    apply_filter(): boolean;
    /**
     * Returns whether the solver has converged.
     */
    converged(): boolean;
    /**
     * Serialize solver state for warm-start cache.
     * Format: [active_len (u32)] [t_fista (f64)] [iteration (u32)] [baseline (f64)] [solution f32...] [solution_prev f32...]
     */
    export_state(): Uint8Array;
    filter_enabled(): boolean;
    /**
     * Returns the estimated scalar baseline.
     */
    get_baseline(): number;
    /**
     * Get filter cutoff frequencies as [f_hp, f_lp].
     */
    get_filter_cutoffs(): Float32Array;
    /**
     * Returns a copy of the kernel.
     *
     * Returns `Vec<f32>` which wasm-bindgen copies into a JS-owned `Float32Array`.
     * A WASM memory view would be unsound here: any subsequent WASM allocation
     * (e.g. `set_trace`) can grow the memory and invalidate the view. The JS side
     * also transfers these buffers via `postMessage`, which requires ownership.
     */
    get_kernel(): Float32Array;
    /**
     * Get the power spectrum of the current trace (N/2+1 bins).
     */
    get_power_spectrum(): Float32Array;
    /**
     * Returns the reconvolution (K * solution) for the active region.
     * Computes the reconvolution lazily if it is stale (not computed during iteration).
     *
     * See `get_kernel` for why this returns an owned copy rather than a memory view.
     */
    get_reconvolution(): Float32Array;
    /**
     * Returns reconvolution with baseline added: K*s + b for the active region.
     * Computes the reconvolution lazily if it is stale.
     *
     * See `get_kernel` for why this returns an owned copy rather than a memory view.
     */
    get_reconvolution_with_baseline(): Float32Array;
    /**
     * Returns the current solution (spike train) for the active region.
     *
     * See `get_kernel` for why this returns an owned copy rather than a memory view.
     */
    get_solution(): Float32Array;
    /**
     * Get frequency axis in Hz for the spectrum bins.
     */
    get_spectrum_frequencies(): Float32Array;
    /**
     * Returns the current trace for the active region.
     * After apply_filter(), this contains the filtered trace.
     *
     * See `get_kernel` for why this returns an owned copy rather than a memory view.
     */
    get_trace(): Float32Array;
    /**
     * Returns the current iteration count.
     */
    iteration_count(): number;
    /**
     * Load warm-start state. If state is empty or wrong size, performs cold-start (zero solution).
     */
    load_state(state: Uint8Array): void;
    /**
     * Create a new Solver with default parameters.
     */
    constructor();
    /**
     * Reset FISTA momentum. Used for warm-start after kernel change.
     * Sets t_fista = 1.0 and copies solution into solution_prev.
     */
    reset_momentum(): void;
    set_filter_enabled(enabled: boolean): void;
    /**
     * Update solver parameters and rebuild kernel.
     */
    set_params(tau_rise: number, tau_decay: number, lambda: number, fs: number): void;
    /**
     * Load a trace for deconvolution. Grows buffers if needed (never shrinks).
     * Resets iteration state for a fresh solve.
     */
    set_trace(trace: Float32Array): void;
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
     */
    step_batch(n_steps: number): boolean;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_solver_free: (a: number, b: number) => void;
    readonly solver_apply_filter: (a: number) => number;
    readonly solver_converged: (a: number) => number;
    readonly solver_export_state: (a: number, b: number) => void;
    readonly solver_filter_enabled: (a: number) => number;
    readonly solver_get_baseline: (a: number) => number;
    readonly solver_get_filter_cutoffs: (a: number, b: number) => void;
    readonly solver_get_kernel: (a: number, b: number) => void;
    readonly solver_get_power_spectrum: (a: number, b: number) => void;
    readonly solver_get_reconvolution: (a: number, b: number) => void;
    readonly solver_get_reconvolution_with_baseline: (a: number, b: number) => void;
    readonly solver_get_solution: (a: number, b: number) => void;
    readonly solver_get_spectrum_frequencies: (a: number, b: number) => void;
    readonly solver_get_trace: (a: number, b: number) => void;
    readonly solver_iteration_count: (a: number) => number;
    readonly solver_load_state: (a: number, b: number, c: number) => void;
    readonly solver_new: () => number;
    readonly solver_reset_momentum: (a: number) => void;
    readonly solver_set_filter_enabled: (a: number, b: number) => void;
    readonly solver_set_params: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly solver_set_trace: (a: number, b: number, c: number) => void;
    readonly solver_step_batch: (a: number, b: number) => number;
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
