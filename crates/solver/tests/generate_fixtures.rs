//! Generate reference fixtures from the Rust solver for Python cross-language tests.
//!
//! Run with: `cargo test generate_fixtures -- --ignored`
//!
//! Outputs JSON fixtures to `../../python/tests/fixtures/`.

use calab_solver::Solver;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize)]
struct Fixture {
    params: FixtureParams,
    trace: Vec<f64>,
    kernel: Vec<f32>,
    solution: Vec<f32>,
    baseline: f64,
    reconvolution: Vec<f32>,
    iterations: u32,
    filter_enabled: bool,
    filtered_trace: Option<Vec<f64>>,
}

#[derive(Serialize)]
struct FixtureParams {
    tau_rise: f64,
    tau_decay: f64,
    lambda: f64,
    fs: f64,
}

fn fixture_dir() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../python/tests/fixtures");
    path
}

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

fn solve_to_convergence(solver: &mut Solver, trace: &[f32], max_batches: u32, batch_size: u32) {
    solver.set_trace(trace);
    solver.subtract_baseline();
    for _ in 0..max_batches {
        if solver.step_batch(batch_size) {
            break;
        }
    }
}

fn write_fixture(name: &str, fixture: &Fixture) {
    let dir = fixture_dir();
    fs::create_dir_all(&dir).expect("Failed to create fixtures directory");
    let path = dir.join(format!("{name}.json"));
    let json = serde_json::to_string_pretty(fixture).expect("Failed to serialize fixture");
    fs::write(&path, json).expect("Failed to write fixture file");
    println!("Wrote fixture: {}", path.display());
}

#[test]
#[ignore]
fn generate_fixtures() {
    // --- standard_clean ---
    {
        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 0.01, 30.0);
        let kernel = solver.get_kernel();
        let trace = build_trace(&kernel, 300, &[20, 80, 150, 230]);
        let trace_f64: Vec<f64> = trace.iter().map(|&v| v as f64).collect();

        solve_to_convergence(&mut solver, &trace, 200, 10);

        write_fixture(
            "standard_clean",
            &Fixture {
                params: FixtureParams {
                    tau_rise: 0.02,
                    tau_decay: 0.4,
                    lambda: 0.01,
                    fs: 30.0,
                },
                trace: trace_f64,
                kernel: kernel.clone(),
                solution: solver.get_solution(),
                baseline: solver.get_baseline(),
                reconvolution: solver.get_reconvolution_with_baseline(),
                iterations: solver.iteration_count(),
                filter_enabled: false,
                filtered_trace: None,
            },
        );
    }

    // --- standard_dc_offset ---
    {
        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 0.01, 30.0);
        let kernel = solver.get_kernel();
        let mut trace = build_trace(&kernel, 300, &[20, 80, 150, 230]);
        for v in trace.iter_mut() {
            *v += 5.0;
        }
        let trace_f64: Vec<f64> = trace.iter().map(|&v| v as f64).collect();

        solve_to_convergence(&mut solver, &trace, 200, 10);

        write_fixture(
            "standard_dc_offset",
            &Fixture {
                params: FixtureParams {
                    tau_rise: 0.02,
                    tau_decay: 0.4,
                    lambda: 0.01,
                    fs: 30.0,
                },
                trace: trace_f64,
                kernel: kernel.clone(),
                solution: solver.get_solution(),
                baseline: solver.get_baseline(),
                reconvolution: solver.get_reconvolution_with_baseline(),
                iterations: solver.iteration_count(),
                filter_enabled: false,
                filtered_trace: None,
            },
        );
    }

    // --- fast_kinetics ---
    {
        let mut solver = Solver::new();
        solver.set_params(0.005, 0.1, 0.01, 100.0);
        let kernel = solver.get_kernel();
        let trace = build_trace(&kernel, 500, &[50, 200, 400]);
        let trace_f64: Vec<f64> = trace.iter().map(|&v| v as f64).collect();

        solve_to_convergence(&mut solver, &trace, 200, 10);

        write_fixture(
            "fast_kinetics",
            &Fixture {
                params: FixtureParams {
                    tau_rise: 0.005,
                    tau_decay: 0.1,
                    lambda: 0.01,
                    fs: 100.0,
                },
                trace: trace_f64,
                kernel: kernel.clone(),
                solution: solver.get_solution(),
                baseline: solver.get_baseline(),
                reconvolution: solver.get_reconvolution_with_baseline(),
                iterations: solver.iteration_count(),
                filter_enabled: false,
                filtered_trace: None,
            },
        );
    }

    // --- high_lambda ---
    {
        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 1.0, 30.0);
        let kernel = solver.get_kernel();
        let trace = build_trace(&kernel, 300, &[20, 80, 150, 230]);
        let trace_f64: Vec<f64> = trace.iter().map(|&v| v as f64).collect();

        solve_to_convergence(&mut solver, &trace, 200, 10);

        write_fixture(
            "high_lambda",
            &Fixture {
                params: FixtureParams {
                    tau_rise: 0.02,
                    tau_decay: 0.4,
                    lambda: 1.0,
                    fs: 30.0,
                },
                trace: trace_f64,
                kernel: kernel.clone(),
                solution: solver.get_solution(),
                baseline: solver.get_baseline(),
                reconvolution: solver.get_reconvolution_with_baseline(),
                iterations: solver.iteration_count(),
                filter_enabled: false,
                filtered_trace: None,
            },
        );
    }

    // --- with_filter ---
    {
        let mut solver = Solver::new();
        solver.set_params(0.02, 0.4, 0.01, 100.0);
        solver.set_filter_enabled(true);
        let kernel = solver.get_kernel();
        let trace = build_trace(&kernel, 1024, &[100, 300, 600, 800]);
        let trace_f64: Vec<f64> = trace.iter().map(|&v| v as f64).collect();

        // Apply filter (modifies the trace in the solver)
        solver.set_trace(&trace);
        solver.apply_filter();
        // Capture filtered trace BEFORE baseline subtraction (for filter comparison test)
        let filtered_trace: Vec<f64> = solver.get_trace().iter().map(|&v| v as f64).collect();
        solver.subtract_baseline();

        // Now solve on the filtered + baseline-subtracted trace
        for _ in 0..200 {
            if solver.step_batch(10) {
                break;
            }
        }

        write_fixture(
            "with_filter",
            &Fixture {
                params: FixtureParams {
                    tau_rise: 0.02,
                    tau_decay: 0.4,
                    lambda: 0.01,
                    fs: 100.0,
                },
                trace: trace_f64,
                kernel: kernel.clone(),
                solution: solver.get_solution(),
                baseline: solver.get_baseline(),
                reconvolution: solver.get_reconvolution_with_baseline(),
                iterations: solver.iteration_count(),
                filter_enabled: true,
                filtered_trace: Some(filtered_trace),
            },
        );
    }
}
