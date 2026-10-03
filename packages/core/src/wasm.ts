// `@calab/core/wasm` entry point: the WASM solver adapter.
//
// Kept out of the `@calab/core` barrel so that importing types, schemas or
// math from `@calab/core` never pulls the wasm-bindgen glue (and the .wasm
// asset it references) into a bundle that does not run the solver.
export {
  initWasm,
  Solver,
  indeca_solve_trace,
  indeca_estimate_kernel,
  indeca_fit_biexponential,
  indeca_compute_upsample_factor,
  seed_trace,
  simulate_traces,
  get_simulation_presets,
  solver_version,
  getSolverVersion,
} from './wasm-adapter.ts';
