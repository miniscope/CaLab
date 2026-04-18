//! Sparse footprint matrix `Ã` (thesis §3.2.3, Eq. 3.18).
//!
//! Each column `Ã[:, i]` is the spatial footprint of estimator `i`,
//! stored as a pair of arrays `(support, values)` covering only the
//! pixels on the column's positive support. Pixel indices use the
//! same row-major convention as `Frame`: `pixel_idx = y * width + x`.
//!
//! Storage is a column-indexed `Vec<Component>` rather than a general
//! sparse matrix (design §5 calls out `sprs` as a possible drop-in
//! once profiling justifies it). The in-house rep keeps push / value
//! mutation / compact cheap, which matters for the `EvaluateFootprints`
//! inner loop that shrinks support morphologically every frame.
//!
//! Each component also carries a stable `u32` id and a
//! `ComponentClass` tag (design §3.1). Ids are never reused; positions
//! can shift when a component is deprecated, but ids survive so Phase
//! 3 `PipelineMutation`s can refer to components unambiguously across
//! apply cycles.

use crate::config::ComponentClass;

/// Sparse non-negative footprint matrix.
#[derive(Debug, Clone)]
pub struct Footprints {
    height: usize,
    width: usize,
    pixels: usize,
    components: Vec<Component>,
    next_id: u32,
}

#[derive(Debug, Clone)]
struct Component {
    /// Stable monotonically-assigned identifier. Never reused once
    /// deprecated, never changes through footprint updates.
    id: u32,
    /// Shape-prior tag (cell / slow-baseline / neuropil).
    class: ComponentClass,
    /// Pixel indices in positive support, sorted strictly ascending.
    support: Vec<u32>,
    /// Values aligned with `support`; all entries are `> 0` after
    /// construction or `compact`.
    values: Vec<f32>,
}

impl Footprints {
    pub fn new(height: usize, width: usize) -> Self {
        assert!(
            height > 0 && width > 0,
            "Footprints requires positive dimensions (got {height}×{width})"
        );
        let pixels = height * width;
        assert!(
            pixels <= u32::MAX as usize,
            "frame pixel count {pixels} exceeds u32::MAX"
        );
        Self {
            height,
            width,
            pixels,
            components: Vec::new(),
            next_id: 0,
        }
    }

    pub fn height(&self) -> usize {
        self.height
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn pixels(&self) -> usize {
        self.pixels
    }

    pub fn len(&self) -> usize {
        self.components.len()
    }

    pub fn is_empty(&self) -> bool {
        self.components.is_empty()
    }

    /// Append a new component with the given positive support. The
    /// component's class defaults to `ComponentClass::Cell`; use
    /// [`Self::push_component_classified`] to tag a non-cell class.
    ///
    /// `support` must be sorted strictly ascending (which also forbids
    /// duplicates); `values` must have the same length and be strictly
    /// positive; pixel indices must be `< pixels()`.
    ///
    /// Returns the component's position index at insertion time.
    /// The position may shift later if an earlier component is
    /// deprecated; use [`Self::id`] + [`Self::position_of`] when the
    /// caller needs id-stable references.
    pub fn push_component(&mut self, support: Vec<u32>, values: Vec<f32>) -> usize {
        self.push_component_classified(support, values, ComponentClass::Cell);
        self.components.len() - 1
    }

    /// Append a new component tagged with the given class. Returns the
    /// stable `u32` id (never reused, never changes).
    pub fn push_component_classified(
        &mut self,
        support: Vec<u32>,
        values: Vec<f32>,
        class: ComponentClass,
    ) -> u32 {
        validate_component(&support, &values, self.pixels);
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).expect("next_id overflowed u32");
        self.components.push(Component {
            id,
            class,
            support,
            values,
        });
        id
    }

    pub fn support(&self, i: usize) -> &[u32] {
        &self.components[i].support
    }

    pub fn values(&self, i: usize) -> &[f32] {
        &self.components[i].values
    }

    pub fn values_mut(&mut self, i: usize) -> &mut [f32] {
        &mut self.components[i].values
    }

    /// Stable id of the component at position `i`.
    pub fn id(&self, i: usize) -> u32 {
        self.components[i].id
    }

    /// Class tag of the component at position `i`.
    pub fn class(&self, i: usize) -> ComponentClass {
        self.components[i].class
    }

    /// Map a stable id back to its current position, or `None` if it
    /// has been deprecated.
    pub fn position_of(&self, id: u32) -> Option<usize> {
        self.components.iter().position(|c| c.id == id)
    }

    /// Remove the component with the given id. Returns its position at
    /// the time of removal, or `None` if the id is not live.
    /// Surviving components keep their ids; their positions shift down
    /// past the removed index.
    pub fn deprecate_by_id(&mut self, id: u32) -> Option<usize> {
        let pos = self.position_of(id)?;
        self.components.remove(pos);
        Some(pos)
    }

    /// The next id that will be assigned by a `push_*` call. Primarily
    /// used by Phase 3 mutation-apply code to allocate ids consistently
    /// across (A, C, W, M, G) in one atomic step.
    pub fn next_id(&self) -> u32 {
        self.next_id
    }

    /// Iterator over current ids in position order.
    pub fn ids(&self) -> impl Iterator<Item = u32> + '_ {
        self.components.iter().map(|c| c.id)
    }

    /// Compute `Aᵀy` — one inner product per column over its support.
    /// Returns a dense length-`k` vector (`k = len()`).
    pub fn aty(&self, y: &[f32]) -> Vec<f32> {
        assert_eq!(
            y.len(),
            self.pixels,
            "y length {} must equal pixels {}",
            y.len(),
            self.pixels
        );
        self.components
            .iter()
            .map(|component| {
                component
                    .support
                    .iter()
                    .zip(&component.values)
                    .map(|(&p, &v)| v * y[p as usize])
                    .sum()
            })
            .collect()
    }

    /// Compute `AᵀA` as a dense `k × k` row-major matrix.
    ///
    /// Uses a two-pointer merge over each pair's sorted supports so the
    /// per-pair cost is `O(|supp_i| + |supp_j|)` rather than
    /// `O(|supp_i| · |supp_j|)`.
    pub fn ata(&self) -> Vec<f32> {
        let k = self.components.len();
        let mut out = vec![0.0f32; k * k];
        for i in 0..k {
            let ci = &self.components[i];
            // Diagonal.
            out[i * k + i] = ci.values.iter().map(|&v| v * v).sum();
            // Upper triangle — mirror to lower to keep symmetry exact.
            for j in (i + 1)..k {
                let cj = &self.components[j];
                let dot = sorted_support_dot(&ci.support, &ci.values, &cj.support, &cj.values);
                out[i * k + j] = dot;
                out[j * k + i] = dot;
            }
        }
        out
    }

    /// Write `Ãc` into `out`. `out` is first zeroed, then each component's
    /// contribution is accumulated at its support pixels.
    pub fn reconstruct(&self, c: &[f32], out: &mut [f32]) {
        assert_eq!(
            c.len(),
            self.components.len(),
            "c length {} must equal number of components {}",
            c.len(),
            self.components.len()
        );
        assert_eq!(
            out.len(),
            self.pixels,
            "out length {} must equal pixels {}",
            out.len(),
            self.pixels
        );
        out.fill(0.0);
        for (component, &ci) in self.components.iter().zip(c) {
            if ci == 0.0 {
                continue;
            }
            for (&p, &v) in component.support.iter().zip(&component.values) {
                out[p as usize] += v * ci;
            }
        }
    }

    /// Drop any entry with value `≤ 0` from component `i`'s support.
    ///
    /// After `EvaluateFootprints` (Algorithm 8 line 5) a value may have
    /// been clamped to zero by the `max(·, 0)` guard. Compact removes
    /// those stale entries so the sparse rep reflects the morphological
    /// shrink. Defensive against negatives as well (should not occur,
    /// but if they do the invariant "values are strictly positive" stays
    /// intact after this call).
    pub fn compact(&mut self, i: usize) {
        let component = &mut self.components[i];
        let mut write = 0usize;
        for read in 0..component.values.len() {
            if component.values[read] > 0.0 {
                component.support[write] = component.support[read];
                component.values[write] = component.values[read];
                write += 1;
            }
        }
        component.support.truncate(write);
        component.values.truncate(write);
    }

    /// For each pixel, count how many components have that pixel in
    /// their positive support. Used by the trace-throttle step, which
    /// only fires on pixels where `count == 1` (a single component's
    /// exclusive support).
    pub fn pixel_component_counts(&self) -> Vec<u32> {
        let mut counts = vec![0u32; self.pixels];
        for component in &self.components {
            for &p in &component.support {
                counts[p as usize] += 1;
            }
        }
        counts
    }
}

fn validate_component(support: &[u32], values: &[f32], pixels: usize) {
    assert_eq!(
        support.len(),
        values.len(),
        "support / values length mismatch: {} vs {}",
        support.len(),
        values.len()
    );
    for win in support.windows(2) {
        assert!(
            win[0] < win[1],
            "support must be strictly ascending (duplicates / out-of-order not allowed)"
        );
    }
    if let Some(&last) = support.last() {
        assert!(
            (last as usize) < pixels,
            "pixel index {last} out of range (pixels = {pixels})"
        );
    }
    for &v in values {
        assert!(v > 0.0, "values must be positive (got {v})");
    }
}

/// Two-pointer merge over two sorted support slices, accumulating the
/// product of aligned values at shared indices.
fn sorted_support_dot(
    support_a: &[u32],
    values_a: &[f32],
    support_b: &[u32],
    values_b: &[f32],
) -> f32 {
    let (mut ia, mut ib) = (0usize, 0usize);
    let mut acc = 0.0f32;
    while ia < support_a.len() && ib < support_b.len() {
        let pa = support_a[ia];
        let pb = support_b[ib];
        match pa.cmp(&pb) {
            std::cmp::Ordering::Less => ia += 1,
            std::cmp::Ordering::Greater => ib += 1,
            std::cmp::Ordering::Equal => {
                acc += values_a[ia] * values_b[ib];
                ia += 1;
                ib += 1;
            }
        }
    }
    acc
}
