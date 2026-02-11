use crate::Solver;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
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
    /// Includes adaptive restart (O'Donoghue & Candes 2015): when the objective
    /// increases, reset momentum to avoid oscillation with non-negativity projection.
    pub fn step_batch(&mut self, n_steps: u32) -> bool {
        let n = self.active_len;
        if n == 0 {
            self.converged = true;
            return true;
        }

        let step_size = 1.0 / self.lipschitz_constant;
        let threshold = step_size * self.lambda;

        for _ in 0..n_steps {
            if self.converged {
                return true;
            }

            // solution_prev holds the extrapolated point y_k
            // (on first iteration, y_0 = x_0 = solution = zeros)

            // 1. Forward convolution at y_k: reconvolution = K * y_k
            //    We evaluate the gradient at y_k, so swap solution and solution_prev
            //    temporarily, or just convolve using solution_prev directly.
            self.convolve_forward_from_prev();

            // 2. Compute residual = K * y_k - trace
            for i in 0..n {
                self.residual_buf[i] = self.reconvolution[i] - self.trace[i];
            }

            // 3. Adjoint convolution: gradient = K^T * residual
            self.convolve_adjoint();

            // 4. Proximal gradient step from y_k:
            //    x_{k+1} = prox(y_k - step_size * gradient)
            //    = max(0, y_k - step_size * gradient - threshold)
            // Save x_k into residual_buf temporarily (we reuse it for restart check)
            for i in 0..n {
                self.residual_buf[i] = self.solution[i]; // save x_k
            }

            for i in 0..n {
                let z = self.solution_prev[i] - step_size * self.gradient[i];
                self.solution[i] = (z - threshold).max(0.0); // x_{k+1}
            }

            // 5. Compute objective at x_{k+1} for convergence and restart checks
            self.convolve_forward(); // reconvolution = K * x_{k+1}
            let objective = self.compute_objective();
            self.iteration += 1;

            // 6. Adaptive restart: if objective increased, restart momentum
            if objective > self.prev_objective && self.iteration > 1 {
                self.t_fista = 1.0;
            }

            // 7. FISTA momentum extrapolation: y_{k+1} = x_{k+1} + momentum * (x_{k+1} - x_k)
            let t_new = (1.0 + (1.0 + 4.0 * self.t_fista * self.t_fista).sqrt()) / 2.0;
            let momentum = (self.t_fista - 1.0) / t_new;

            for i in 0..n {
                let x_k = self.residual_buf[i]; // previous x_k
                let x_new = self.solution[i]; // x_{k+1}
                // y_{k+1} = x_{k+1} + momentum * (x_{k+1} - x_k)
                let y_new = x_new + momentum * (x_new - x_k);
                // Project to non-negative for the extrapolated point
                self.solution_prev[i] = y_new.max(0.0);
            }
            self.t_fista = t_new;

            // 8. Convergence check
            if self.iteration > 5 {
                let rel_change =
                    (self.prev_objective - objective).abs() / (self.prev_objective.abs() + 1e-10);
                if rel_change < self.tolerance {
                    self.converged = true;
                }
            }
            self.prev_objective = objective;
        }

        self.converged
    }

    /// Forward (causal) convolution: reconvolution[t] = sum_k kernel[k] * solution[t-k]
    fn convolve_forward(&mut self) {
        let n = self.active_len;
        let k_len = self.kernel.len();

        for t in 0..n {
            let mut sum = 0.0;
            let k_max = k_len.min(t + 1);
            for k in 0..k_max {
                sum += self.kernel[k] * self.solution[t - k];
            }
            self.reconvolution[t] = sum;
        }
    }

    /// Forward convolution from the extrapolated point (solution_prev = y_k):
    /// reconvolution[t] = sum_k kernel[k] * solution_prev[t-k]
    fn convolve_forward_from_prev(&mut self) {
        let n = self.active_len;
        let k_len = self.kernel.len();

        for t in 0..n {
            let mut sum = 0.0;
            let k_max = k_len.min(t + 1);
            for k in 0..k_max {
                sum += self.kernel[k] * self.solution_prev[t - k];
            }
            self.reconvolution[t] = sum;
        }
    }

    /// Adjoint (correlation) convolution: gradient[t] = sum_k kernel[k] * residual_buf[t+k]
    /// Uses residual_buf as input (must be filled before calling).
    fn convolve_adjoint(&mut self) {
        let n = self.active_len;
        let k_len = self.kernel.len();

        for t in 0..n {
            let mut sum = 0.0;
            let k_max = k_len.min(n - t);
            for k in 0..k_max {
                sum += self.kernel[k] * self.residual_buf[t + k];
            }
            self.gradient[t] = sum;
        }
    }

    /// Compute objective: (1/2)||reconvolution - trace||^2 + lambda * sum(solution)
    fn compute_objective(&self) -> f64 {
        let n = self.active_len;
        let mut data_fidelity = 0.0;
        let mut l1_penalty = 0.0;

        for i in 0..n {
            let residual = self.reconvolution[i] - self.trace[i];
            data_fidelity += residual * residual;
            l1_penalty += self.solution[i]; // solution is non-negative, so ||s||_1 = sum(s)
        }

        0.5 * data_fidelity + self.lambda * l1_penalty
    }
}

#[cfg(test)]
mod tests {
    use crate::kernel::build_kernel;
    use crate::Solver;

    /// Helper: create a solver with given params and run to convergence
    fn solve_to_convergence(
        solver: &mut Solver,
        trace: &[f64],
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
        let sum_others: f64 = solution
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

        let trace = vec![0.0; 100];
        solve_to_convergence(&mut solver, &trace, 100, 10);

        let solution = solver.get_solution();
        let max_val = solution.iter().cloned().fold(0.0_f64, f64::max);
        assert!(
            max_val < 1e-10,
            "Zero trace should produce zero solution, max = {}",
            max_val
        );
    }

    // Test 3: Convergence flag is set within 500 iterations
    #[test]
    fn convergence_flag_set() {
        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 0.01, 30.0);

        // Create a simple trace: kernel convolved with a spike train
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 200;
        let mut trace = vec![0.0; n];

        // Place spikes at a few locations
        let spikes = [10, 50, 100, 150];
        for &s in &spikes {
            for (k, &kv) in kernel.iter().enumerate() {
                if s + k < n {
                    trace[s + k] += kv;
                }
            }
        }

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
        let mut trace = vec![0.0; n];
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
            trace[i] += 0.01 * ((i as f64 * 0.7).sin());
        }

        solve_to_convergence(&mut solver, &trace, 200, 10);

        let solution = solver.get_solution();
        for (i, &v) in solution.iter().enumerate() {
            assert!(
                v >= 0.0,
                "Solution at index {} is negative: {}",
                i,
                v
            );
        }
    }

    // Test 5: Determinism -- same trace + params produces identical solution
    #[test]
    fn deterministic_output() {
        let kernel = build_kernel(0.02, 0.4, 30.0);
        let n = 150;
        let mut trace = vec![0.0; n];
        let spikes = [10, 50, 100];
        for &s in &spikes {
            for (k, &kv) in kernel.iter().enumerate() {
                if s + k < n {
                    trace[s + k] += kv;
                }
            }
        }

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
                (sol1[i] - sol2[i]).abs() < 1e-15,
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
        let mut trace = vec![0.0; n];
        let spikes = [10, 50, 100, 150];
        for &s in &spikes {
            for (k, &kv) in kernel.iter().enumerate() {
                if s + k < n {
                    trace[s + k] += kv;
                }
            }
        }

        solve_to_convergence(&mut solver, &trace, 200, 10);

        let reconvolution = solver.get_reconvolution();

        // Compute relative error: ||trace - reconvolution|| / ||trace||
        let mut err_sq = 0.0;
        let mut trace_sq = 0.0;
        for i in 0..n {
            let diff = trace[i] - reconvolution[i];
            err_sq += diff * diff;
            trace_sq += trace[i] * trace[i];
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
        let n = 200;
        let mut trace = vec![0.0; n];
        let spikes = [10, 50, 100, 150];
        for &s in &spikes {
            for (k, &kv) in kernel.iter().enumerate() {
                if s + k < n {
                    trace[s + k] += kv;
                }
            }
        }

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
        let mut trace = vec![0.0; n];
        for (k, &kv) in kernel.iter().enumerate() {
            if k < n {
                trace[k] += kv;
            }
        }

        solver.set_trace(&trace);
        // Run a few iterations to build up momentum
        solver.step_batch(20);
        assert!(solver.t_fista > 1.0, "t_fista should have increased from 1.0");

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
                (solver.solution[i] - solver.solution_prev[i]).abs() < 1e-15,
                "solution_prev should equal solution at index {}",
                i
            );
        }
    }
}
