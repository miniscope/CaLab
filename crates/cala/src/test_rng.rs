//! Seeded generators for tests. Every test that draws from a seed gets the
//! same stream, so fixtures built from a seed do not shift. The integration
//! tests include this file too (`tests/common/mod.rs`).

/// 64-bit LCG (Knuth's MMIX constants). [`Lcg::normal`] is the sum of 12
/// uniforms − 6: unit variance, bounded to ±6.
pub struct Lcg(pub u64);

impl Lcg {
    /// Uniform in `[0, 1)`, 24 bits.
    pub fn next(&mut self) -> f32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 40) as f32) / (1u64 << 24) as f32
    }

    /// Approximately standard normal (sum of 12 uniforms − 6).
    pub fn normal(&mut self) -> f32 {
        (0..12).map(|_| self.next()).sum::<f32>() - 6.0
    }
}

/// The same LCG with Box-Muller normals; its uniforms sit half a step above
/// [`Lcg::next`]'s, in `(0, 1)`, so the logarithm is finite.
pub struct LcgBoxMuller(pub u64);

impl LcgBoxMuller {
    /// Uniform in `(0, 1)`, 24 bits.
    pub fn uniform(&mut self) -> f32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 40) as f32 + 0.5) / (1u64 << 24) as f32
    }

    /// Standard normal (Box-Muller, one of the pair).
    pub fn normal(&mut self) -> f32 {
        let (u, v) = (self.uniform(), self.uniform());
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f32::consts::PI * v).cos()
    }
}
