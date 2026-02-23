# Test Fixtures

Reference values for cross-language equivalence testing between the Python
`calab` package and the Rust/WASM solver (`crates/solver/`).

## Parameter Sets

Three standard parameter sets cover the range of typical calcium imaging:

- **Standard:** tau_rise=0.02, tau_decay=0.4, fs=30.0 (GCaMP6f, 2-photon)
- **Fast:** tau_rise=0.005, tau_decay=0.1, fs=100.0 (jGCaMP8f, resonant scanning)
- **Slow:** tau_rise=0.05, tau_decay=1.0, fs=20.0 (GCaMP6s, widefield)

## Verification Strategy

The Rust solver tests (`crates/solver/src/kernel.rs`) verify correctness
of the Rust implementation. The Python tests verify numerical equivalence with
the Rust implementation by:

1. Using identical formulas with identical variable names
2. Comparing DFT-based Lipschitz via explicit loop (matching Rust) vs np.fft.fft
3. Testing the same properties (peak normalization, root bounds, etc.)

Since both implementations use IEEE 754 Float64 arithmetic, results match
within rtol=1e-10.
