//! Deterministic noise generators shared by the unit tests.

/// Uniform noise in `[-amp, amp)` from a 64-bit LCG.
pub(crate) fn lcg_noise(n: usize, amp: f32, seed: u64) -> Vec<f32> {
    let mut state = seed;
    (0..n)
        .map(|_| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let u = ((state >> 32) as f64) / ((1u64 << 31) as f64) - 1.0;
            (u as f32) * amp
        })
        .collect()
}

/// White Gaussian noise of std `sigma` (xorshift64 + Box-Muller).
pub(crate) fn white(n: usize, sigma: f64, seed: u64) -> Vec<f32> {
    let mut s = seed.max(1);
    let mut next = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s >> 11) as f64 / (1u64 << 53) as f64
    };
    (0..n)
        .map(|_| {
            let u1 = next().max(1e-12);
            let u2 = next();
            (sigma * (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()) as f32
        })
        .collect()
}
