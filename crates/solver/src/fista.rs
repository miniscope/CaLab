use crate::{Constraint, ConvMode, Solver};

#[cfg(feature = "jsbindings")]
use wasm_bindgen::prelude::*;

#[cfg_attr(feature = "jsbindings", wasm_bindgen)]
impl Solver {
    /// Run n_steps of FISTA iterations. Returns true if converged.
    ///
    /// Uses the standard Beck & Teboulle FISTA with two sequences:
    /// - x_k (solution): the proximal update point
    /// - y_k (solution_prev used as extrapolated point): where gradient is evaluated
    ///
    /// The algorithm evaluates the gradient at the extrapolated point y_k, takes
    /// the proximal step to get x_{k+1}, then extrapolates to get y_{k+1}.
    ///
    /// Includes adaptive restart (O'Donoghue & Candes 2015): when the gradient-mapping
    /// criterion detects momentum is hurting progress, reset to avoid oscillation.
    ///
    /// Uses FFT-based O(n log n) convolutions instead of time-domain O(n*k), and
    /// primal residual convergence criterion to eliminate one convolution per iteration.
    pub fn step_batch(&mut self, n_steps: u32) -> bool {
        let n = self.active_len;
        if n == 0 {
            self.converged = true;
            return true;
        }

        let step_size = 1.0 / self.lipschitz_constant;
        let threshold = step_size * self.effective_lambda();
        let tol_sq = self.tolerance * self.tolerance;

        for _ in 0..n_steps {
            if self.converged {
                return true;
            }

            // solution_prev holds the extrapolated point y_k
            // (on first iteration, y_0 = x_0 = solution = zeros)

            // 1. Forward convolution at y_k: reconvolution = K * y_k
            match self.conv_mode {
                ConvMode::Fft => self.fft.convolve_forward(
                    &self.solution_prev[..n],
                    n,
                    &mut self.reconvolution[..n],
                ),
                ConvMode::BandedAR2 => self
                    .banded
                    .convolve_forward(&self.solution_prev[..n], &mut self.reconvolution[..n]),
            }

            // 1b. Compute baseline: b = mean(trace - K*y_k)
            //     Skip when bandpass-filtered — DC is already removed, and the baseline
            //     mathematically cancels in the gradient (residual = mean-centered signals).
            //     Computing it anyway would produce pure momentum-oscillation noise.
            if !self.filtered {
                let mut sum = 0.0_f64;
                for i in 0..n {
                    sum += (self.trace[i] - self.reconvolution[i]) as f64;
                }
                let raw_baseline = sum / n as f64;
                self.baseline = raw_baseline;

                // Per-iteration EMA smoothing for display baseline
                if !self.baseline_ema_init {
                    self.baseline_ema = raw_baseline;
                    self.baseline_ema_init = true;
                } else {
                    self.baseline_ema = 0.3 * raw_baseline + 0.7 * self.baseline_ema;
                }
            }

            // 2. Compute residual = K * y_k + b - trace
            let baseline_f32 = self.baseline as f32;
            for i in 0..n {
                self.residual_buf[i] = self.reconvolution[i] + baseline_f32 - self.trace[i];
            }

            // 3. Adjoint convolution: gradient = K^T * residual
            match self.conv_mode {
                ConvMode::Fft => {
                    self.fft
                        .convolve_adjoint(&self.residual_buf[..n], n, &mut self.gradient[..n])
                }
                ConvMode::BandedAR2 => self
                    .banded
                    .convolve_adjoint(&self.residual_buf[..n], &mut self.gradient[..n]),
            }

            // 4. Loop A (fused): save x_k + proximal gradient step
            //    x_{k+1} = prox(y_k - step_size * gradient)
            //    Constraint match hoisted outside inner loop for SIMD auto-vectorization.
            let step_f32 = step_size as f32;
            let thresh_f32 = threshold as f32;
            match self.constraint {
                Constraint::NonNegative => {
                    for i in 0..n {
                        let x_old = self.solution[i];
                        self.residual_buf[i] = x_old;
                        let z = self.solution_prev[i] - step_f32 * self.gradient[i];
                        self.solution[i] = (z - thresh_f32).max(0.0);
                    }
                }
                Constraint::Box01 => {
                    for i in 0..n {
                        let x_old = self.solution[i];
                        self.residual_buf[i] = x_old;
                        let z = self.solution_prev[i] - step_f32 * self.gradient[i];
                        self.solution[i] = z.clamp(0.0, 1.0);
                    }
                }
            }

            self.iteration += 1;

            // 5+6. Fused Loop B+C: convergence/restart accumulators + momentum extrapolation.
            // Compute tentative momentum BEFORE the loop (only depends on self.t_fista).
            // On restart (rare), correct with a single copy_from_slice afterwards.
            let t_new = (1.0 + (1.0 + 4.0 * self.t_fista * self.t_fista).sqrt()) / 2.0;
            let momentum = ((self.t_fista - 1.0) / t_new) as f32;
            let check_restart = self.iteration > 1;

            let mut diff_sq = 0.0_f64;
            let mut xk_sq = 0.0_f64;
            let mut dot = 0.0_f64;

            // Constraint match hoisted outside the inner loop for SIMD auto-vectorization.
            // The `dot` accumulator is always computed (one fma per element) to avoid
            // duplicating the loop body for the check_restart branch.
            match self.constraint {
                Constraint::NonNegative => {
                    for i in 0..n {
                        let x_new = self.solution[i];
                        let x_old = self.residual_buf[i];
                        let x_new_f64 = x_new as f64;
                        let x_old_f64 = x_old as f64;
                        let d = x_new_f64 - x_old_f64;
                        diff_sq += d * d;
                        xk_sq += x_old_f64 * x_old_f64;
                        dot += (self.solution_prev[i] as f64 - x_new_f64) * d;
                        self.solution_prev[i] = (x_new + momentum * (x_new - x_old)).max(0.0);
                    }
                }
                Constraint::Box01 => {
                    for i in 0..n {
                        let x_new = self.solution[i];
                        let x_old = self.residual_buf[i];
                        let x_new_f64 = x_new as f64;
                        let x_old_f64 = x_old as f64;
                        let d = x_new_f64 - x_old_f64;
                        diff_sq += d * d;
                        xk_sq += x_old_f64 * x_old_f64;
                        dot += (self.solution_prev[i] as f64 - x_new_f64) * d;
                        self.solution_prev[i] =
                            (x_new + momentum * (x_new - x_old)).clamp(0.0, 1.0);
                    }
                }
            }

            // Adaptive restart: if momentum hurt progress, reset.
            // Undo the speculative momentum by setting solution_prev = solution.
            // This is correct because with momentum=0, y_{k+1} = x_{k+1} = solution,
            // and solution already satisfies Box01 from the prox step.
            if check_restart && dot > 0.0 {
                self.t_fista = 1.0;
                self.solution_prev[..n].copy_from_slice(&self.solution[..n]);
            } else {
                self.t_fista = t_new;
            }

            // 7. Convergence check using primal residual (squared comparison)
            if self.iteration > 5 && diff_sq < tol_sq * (xk_sq + 1e-20) {
                self.converged = true;
            }

            // Mark reconvolution as stale (it currently holds K*y_k, not K*x_{k+1})
            self.reconvolution_stale = true;
        }

        self.converged
    }
}

#[cfg(test)]
mod tests {
    use crate::kernel::build_kernel;
    use crate::Solver;

    /// Helper: create a solver with given params and run to convergence
    fn solve_to_convergence(
        solver: &mut Solver,
        trace: &[f32],
        max_batches: u32,
        batch_size: u32,
    ) -> u32 {
        solver.set_trace(trace);
        let mut total_batches = 0;
        for _ in 0..max_batches {
            total_batches += 1;
            if solver.step_batch(batch_size) {
                break;
            }
        }
        total_batches
    }

    /// Helper: build an f32 trace from kernel convolved with spikes
    fn build_trace(kernel: &[f32], n: usize, spikes: &[usize]) -> Vec<f32> {
        let mut trace = vec![0.0_f32; n];
        for &s in spikes {
            for (k, &kv) in kernel.iter().enumerate() {
                if s + k < n {
                    trace[s + k] += kv;
                }
            }
        }
        trace
    }

    // Test 1: Delta impulse recovery
    // trace = kernel (convolving a single spike at t=0 produces the kernel)
    // Solver should recover a spike at t=0 and near-zeros elsewhere
    #[test]
    fn delta_impulse_recovery() {
        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 0.001, 30.0); // very low lambda for clean recovery

        // The trace IS the kernel (what you'd get from a single spike at t=0)
        let trace = build_kernel(0.02, 0.4, 30.0);
        let n = trace.len();

        solve_to_convergence(&mut solver, &trace, 200, 10);

        let solution = solver.get_solution();
        assert_eq!(solution.len(), n);

        // Find max spike location - should be near the beginning
        let max_idx = solution
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap()
            .0;

        // The spike should be in the first few samples (t=0 or t=1 due to kernel[0]=0)
        assert!(
            max_idx <= 2,
            "Max spike should be near t=0, got index {}",
            max_idx
        );

        // The primary spike should be substantial
        let spike_val = solution[max_idx];
        assert!(
            spike_val > 0.1,
            "Primary spike should be > 0.1, got {}",
            spike_val
        );

        // Sum of all other values should be small relative to the spike
        let sum_others: f32 = solution
            .iter()
            .enumerate()
            .filter(|&(i, _)| i != max_idx)
            .map(|(_, v)| v)
            .sum();
        assert!(
            sum_others < spike_val,
            "Sum of non-spike values ({}) should be less than spike ({})",
            sum_others,
            spike_val
        );
    }

    // Test 2: Zero trace produces zero solution
    #[test]
    fn zero_trace_produces_zero_solution() {
        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 0.01, 30.0);

        let trace = vec![0.0_f32; 100];
        solve_to_convergence(&mut solver, &trace, 100, 10);

        let solution = solver.get_solution();
        let max_val = solution.iter().cloned().fold(0.0_f32, f32::max);
        assert!(
            max_val < 1e-6,
            "Zero trace should produce zero solution, max = {}",
            max_val
        );
    }

    // Test 3: Convergence flag is set within 500 iterations
    #[test]
    fn convergence_flag_set() {
        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 0.01, 30.0);

        let kernel = build_kernel(0.02, 0.4, 30.0);
        let trace = build_trace(&kernel, 200, &[10, 50, 100, 150]);

        solve_to_convergence(&mut solver, &trace, 100, 10);

        assert!(
            solver.converged(),
            "Solver should converge within 1000 iterations, got {} iterations",
            solver.iteration_count()
        );
    }

    // Test 4: Non-negativity of solution
    #[test]
    fn solution_non_negative() {
        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 0.01, 30.0);

        // Create a noisy trace
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 200;
        let mut trace = vec![0.0_f32; n];
        let spikes = [20, 60, 120];
        for &s in &spikes {
            for (k, &kv) in kernel.iter().enumerate() {
                if s + k < n {
                    trace[s + k] += kv * 2.0;
                }
            }
        }
        // Add some noise-like perturbation
        for i in 0..n {
            trace[i] += 0.01 * ((i as f32 * 0.7).sin());
        }

        solve_to_convergence(&mut solver, &trace, 200, 10);

        let solution = solver.get_solution();
        for (i, &v) in solution.iter().enumerate() {
            assert!(v >= 0.0, "Solution at index {} is negative: {}", i, v);
        }
    }

    // Test 5: Determinism -- same trace + params produces identical solution
    #[test]
    fn deterministic_output() {
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let trace = build_trace(&kernel, 150, &[10, 50, 100]);

        // Run 1
        let mut solver1 = Solver::new();
        solver1.set_params(0.02, 0.4, 0.01, 30.0);
        solve_to_convergence(&mut solver1, &trace, 200, 10);
        let sol1 = solver1.get_solution();

        // Run 2
        let mut solver2 = Solver::new();
        solver2.set_params(0.02, 0.4, 0.01, 30.0);
        solve_to_convergence(&mut solver2, &trace, 200, 10);
        let sol2 = solver2.get_solution();

        assert_eq!(sol1.len(), sol2.len());
        for i in 0..sol1.len() {
            assert!(
                (sol1[i] - sol2[i]).abs() < 1e-7,
                "Solutions differ at index {}: {} vs {}",
                i,
                sol1[i],
                sol2[i]
            );
        }
    }

    // Test 6: Reconvolution quality -- reconvolution approximates original trace
    #[test]
    fn reconvolution_quality() {
        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 0.001, 30.0); // low lambda for faithful reconstruction

        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 200;
        let trace = build_trace(&kernel, n, &[10, 50, 100, 150]);

        solve_to_convergence(&mut solver, &trace, 200, 10);

        let reconvolution = solver.get_reconvolution();

        // Compute relative error: ||trace - reconvolution|| / ||trace||
        let mut err_sq = 0.0_f64;
        let mut trace_sq = 0.0_f64;
        for i in 0..n {
            let diff = (trace[i] - reconvolution[i]) as f64;
            err_sq += diff * diff;
            trace_sq += (trace[i] as f64) * (trace[i] as f64);
        }

        let rel_error = (err_sq / trace_sq).sqrt();
        assert!(
            rel_error < 0.1,
            "Relative reconvolution error should be < 0.1, got {}",
            rel_error
        );
    }

    // Test 7: Warm-start convergence -- second solve with slight lambda change converges faster
    #[test]
    fn warm_start_faster_convergence() {
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let trace = build_trace(&kernel, 200, &[10, 50, 100, 150]);

        // Cold start solve with original lambda
        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 0.01, 30.0);
        solve_to_convergence(&mut solver, &trace, 200, 10);

        // Export state from converged solution
        let state = solver.export_state();

        // Warm-start: set new lambda, load trace, restore state, solve
        let mut warm_solver = Solver::new();
        warm_solver.set_params(0.02, 0.4, 0.012, 30.0);
        warm_solver.set_trace(&trace);
        warm_solver.load_state(&state);
        // load_state restores the solution; need to also copy into solution_prev
        // (the extrapolated point y_0 = x_0 for warm-start)
        let active = warm_solver.active_len;
        warm_solver.solution_prev[..active].copy_from_slice(&warm_solver.solution[..active]);
        warm_solver.converged = false;
        warm_solver.prev_objective = f64::INFINITY;
        warm_solver.iteration = 0;
        warm_solver.t_fista = 1.0;

        for _ in 0..200 {
            if warm_solver.step_batch(10) {
                break;
            }
        }
        let warm_iters = warm_solver.iteration_count();

        // Cold start with new lambda
        let mut cold_solver = Solver::new();
        cold_solver.set_params(0.02, 0.4, 0.012, 30.0);
        solve_to_convergence(&mut cold_solver, &trace, 200, 10);
        let cold_iters = cold_solver.iteration_count();

        assert!(
            warm_iters < cold_iters,
            "Warm-start ({} iters) should converge faster than cold-start ({} iters)",
            warm_iters,
            cold_iters
        );
    }

    // Test 8: Momentum reset -- after set_params with changed tau, t_fista = 1.0
    #[test]
    fn momentum_reset_after_kernel_change() {
        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 0.01, 30.0);

        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 100;
        let mut trace = vec![0.0_f32; n];
        for (k, &kv) in kernel.iter().enumerate() {
            if k < n {
                trace[k] += kv;
            }
        }

        solver.set_trace(&trace);
        // Run a few iterations to build up momentum
        solver.step_batch(20);
        assert!(
            solver.t_fista > 1.0,
            "t_fista should have increased from 1.0"
        );

        // Reset momentum (simulating kernel change warm-start)
        solver.reset_momentum();
        assert!(
            (solver.t_fista - 1.0).abs() < 1e-15,
            "t_fista should be 1.0 after reset, got {}",
            solver.t_fista
        );

        // solution_prev should equal solution
        let sol = solver.get_solution();
        for i in 0..sol.len() {
            assert!(
                (solver.solution[i] - solver.solution_prev[i]).abs() < 1e-7,
                "solution_prev should equal solution at index {}",
                i
            );
        }
    }

    // Test 9: Baseline recovery with DC offset
    // trace = K*spikes + DC, verify get_baseline() recovers the DC value
    #[test]
    fn baseline_recovery_with_dc_offset() {
        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 0.001, 30.0); // low lambda for clean recovery

        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 200;
        let dc_offset = 5.0_f32;
        let mut trace = build_trace(&kernel, n, &[10, 50, 100, 150]);
        for i in 0..n {
            trace[i] += dc_offset;
        }

        solve_to_convergence(&mut solver, &trace, 200, 10);

        // Baseline should be close to the DC offset
        let baseline = solver.get_baseline();
        assert!(
            (baseline - dc_offset as f64).abs() < 1.0,
            "Baseline should be close to DC offset {}, got {}",
            dc_offset,
            baseline
        );

        // Reconvolution with baseline should approximate the original trace
        let reconv = solver.get_reconvolution_with_baseline();
        let mut err_sq = 0.0_f64;
        let mut trace_sq = 0.0_f64;
        for i in 0..n {
            let diff = (trace[i] - reconv[i]) as f64;
            err_sq += diff * diff;
            trace_sq += (trace[i] as f64) * (trace[i] as f64);
        }
        let rel_error = (err_sq / trace_sq).sqrt();
        assert!(
            rel_error < 0.1,
            "Relative reconvolution+baseline error should be < 0.1, got {}",
            rel_error
        );
    }

    // Test 10: Higher lambda produces fewer nonzero spikes
    #[test]
    fn lambda_scaling_affects_sparsity() {
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 200;
        let trace = build_trace(&kernel, n, &[10, 50, 100, 150]);

        // Solve with low lambda
        let mut solver_low = Solver::new();
        solver_low.set_params(0.02, 0.4, 0.01, 30.0);
        solve_to_convergence(&mut solver_low, &trace, 200, 10);
        let sol_low = solver_low.get_solution();
        let nnz_low = sol_low.iter().filter(|&&v| v > 1e-6).count();

        // Solve with high lambda
        let mut solver_high = Solver::new();
        solver_high.set_params(0.02, 0.4, 1.0, 30.0);
        solve_to_convergence(&mut solver_high, &trace, 200, 10);
        let sol_high = solver_high.get_solution();
        let nnz_high = sol_high.iter().filter(|&&v| v > 1e-6).count();

        assert!(
            nnz_high < nnz_low,
            "Higher lambda should produce fewer nonzero spikes: nnz_high={} vs nnz_low={}",
            nnz_high,
            nnz_low
        );
    }

    // Test 11: FFT convolution matches time-domain convolution
    #[test]
    fn fft_convolution_matches_time_domain() {
        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 0.01, 30.0);

        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 200;
        let trace = build_trace(&kernel, n, &[10, 50, 100, 150]);
        solver.set_trace(&trace);

        // Set up a known signal in solution_prev
        for i in 0..n {
            solver.solution_prev[i] = trace[i];
        }

        // FFT-based forward convolution
        let mut fft_result = vec![0.0_f32; n];
        solver
            .fft
            .convolve_forward(&solver.solution_prev[..n], n, &mut fft_result);

        // Time-domain forward convolution for comparison
        let k_len = kernel.len();
        let mut td_result = vec![0.0_f32; n];
        for t in 0..n {
            let mut sum = 0.0;
            let k_max = k_len.min(t + 1);
            for k in 0..k_max {
                sum += kernel[k] * solver.solution_prev[t - k];
            }
            td_result[t] = sum;
        }

        // Compare results — should match within f32 precision.
        // Use absolute tolerance for values near zero, relative tolerance otherwise.
        for i in 0..n {
            let diff = (fft_result[i] - td_result[i]).abs();
            let abs_ok = diff < 1e-4;
            let rel_ok = diff / td_result[i].abs().max(1e-6) < 1e-3;
            assert!(
                abs_ok || rel_ok,
                "FFT vs time-domain mismatch at index {}: fft={} td={} diff={}",
                i,
                fft_result[i],
                td_result[i],
                diff
            );
        }
    }

    // Test 12: BandedAR2 mode converges and produces non-negative solution
    #[test]
    fn banded_mode_converges() {
        use crate::ConvMode;

        let kernel = build_kernel(0.02, 0.4, 30.0);
        let trace = build_trace(&kernel, 200, &[10, 50, 100, 150]);

        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 0.01, 30.0);
        solver.set_conv_mode(ConvMode::BandedAR2);
        solve_to_convergence(&mut solver, &trace, 200, 10);

        assert!(
            solver.converged(),
            "BandedAR2 solver should converge within 2000 iterations, got {}",
            solver.iteration_count()
        );

        let solution = solver.get_solution();
        for (i, &v) in solution.iter().enumerate() {
            assert!(
                v >= 0.0,
                "BandedAR2 solution at index {} is negative: {}",
                i,
                v
            );
        }

        // Should have found some nonzero spikes
        let nnz = solution.iter().filter(|&&v| v > 1e-6).count();
        assert!(nnz > 0, "BandedAR2 should produce some nonzero spikes");
    }

    // Test 13: Box01 constraint produces values in [0, 1]
    #[test]
    fn box01_constraint_bounds() {
        use crate::{Constraint, ConvMode};

        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 200;
        let trace = build_trace(&kernel, n, &[10, 50, 100, 150]);

        // Scale trace so solution would exceed 1.0 without box constraint
        let scaled_trace: Vec<f32> = trace.iter().map(|&v| v * 5.0).collect();

        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 0.001, 30.0); // low lambda for large values
        solver.set_conv_mode(ConvMode::BandedAR2);
        solver.set_constraint(Constraint::Box01);
        solve_to_convergence(&mut solver, &scaled_trace, 200, 10);

        let solution = solver.get_solution();
        for (i, &v) in solution.iter().enumerate() {
            assert!(
                v >= 0.0 && v <= 1.0,
                "Box01 solution at index {} should be in [0,1], got {}",
                i,
                v
            );
        }
    }
}
