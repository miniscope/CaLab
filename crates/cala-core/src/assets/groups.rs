//! Group partition `G` (thesis §3.2.3, Algorithm 7 line 9).
//!
//! Components `i` and `j` are in the same group iff their positive
//! spatial supports intersect (directly or transitively). The partition
//! matches the connected components of the `AᵀA ≠ 0` graph and is what
//! `EvaluateTraces` iterates over: within a group the BCD update is
//! coupled, across groups it decouples so groups can be processed
//! independently (and in principle in parallel).
//!
//! Computation uses a pixel-indexed union-find: for every pixel, we
//! union all components that touch it. Cost is `O(Σᵢ |supp_i| · α(k))`
//! per rebuild, cheap enough to recompute from scratch when footprints
//! change rather than maintain incrementally.

use super::Footprints;

#[derive(Debug, Clone)]
pub struct Groups {
    groups: Vec<Vec<usize>>,
    component_to_group: Vec<usize>,
}

impl Groups {
    pub fn from_footprints(fp: &Footprints) -> Self {
        let k = fp.len();
        if k == 0 {
            return Self {
                groups: Vec::new(),
                component_to_group: Vec::new(),
            };
        }
        let mut uf = UnionFind::new(k);

        // For each pixel, union every pair of components that share it.
        // Cheaper than the explicit k×k pair check when supports are sparse.
        let mut first_per_pixel: Vec<i32> = vec![-1; fp.pixels()];
        for component in 0..k {
            for &p in fp.support(component) {
                let p = p as usize;
                let prev = first_per_pixel[p];
                if prev < 0 {
                    first_per_pixel[p] = component as i32;
                } else {
                    uf.union(prev as usize, component);
                }
            }
        }

        // Collect components into group vectors keyed by their root.
        let mut group_of_root: Vec<i32> = vec![-1; k];
        let mut groups: Vec<Vec<usize>> = Vec::new();
        let mut component_to_group = vec![0usize; k];
        for i in 0..k {
            let root = uf.find(i);
            let gi = if group_of_root[root] < 0 {
                let gi = groups.len();
                groups.push(Vec::new());
                group_of_root[root] = gi as i32;
                gi
            } else {
                group_of_root[root] as usize
            };
            groups[gi].push(i);
            component_to_group[i] = gi;
        }

        Self {
            groups,
            component_to_group,
        }
    }

    pub fn len(&self) -> usize {
        self.groups.len()
    }

    pub fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }

    pub fn num_components(&self) -> usize {
        self.component_to_group.len()
    }

    pub fn group(&self, g: usize) -> &[usize] {
        &self.groups[g]
    }

    pub fn group_of(&self, component: usize) -> usize {
        self.component_to_group[component]
    }

    pub fn iter_groups(&self) -> impl Iterator<Item = &[usize]> {
        self.groups.iter().map(Vec::as_slice)
    }
}

struct UnionFind {
    parent: Vec<usize>,
    rank: Vec<u8>,
}

impl UnionFind {
    fn new(n: usize) -> Self {
        Self {
            parent: (0..n).collect(),
            rank: vec![0; n],
        }
    }

    fn find(&mut self, mut x: usize) -> usize {
        while self.parent[x] != x {
            self.parent[x] = self.parent[self.parent[x]];
            x = self.parent[x];
        }
        x
    }

    fn union(&mut self, a: usize, b: usize) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra == rb {
            return;
        }
        match self.rank[ra].cmp(&self.rank[rb]) {
            std::cmp::Ordering::Less => self.parent[ra] = rb,
            std::cmp::Ordering::Greater => self.parent[rb] = ra,
            std::cmp::Ordering::Equal => {
                self.parent[rb] = ra;
                self.rank[ra] += 1;
            }
        }
    }
}
