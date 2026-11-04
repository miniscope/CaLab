/** Parameters for one batched solve (all cells share them). */
export interface GpuFistaParams {
  tauRise: number;
  tauDecay: number;
  fs: number;
  lambda: number;
  constraint: 'nonneg' | 'box01';
  /** Relative primal-residual tolerance. 0 disables convergence (timing runs). */
  tol: number;
  maxIters: number;
  /**
   * True when the trace was high-pass filtered or baseline-subtracted
   * (`Solver.filtered` in Rust): the scalar baseline is pinned to 0. When
   * false the baseline is re-estimated every iteration as mean(trace - K*y).
   */
  filtered: boolean;
}
