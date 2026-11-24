//! Bitwise equivalence of the fast `Problem` builders with the original
//! `Problem::new` (kept here as `reference_new`).

use super::*;
use crate::trace::LibraryConfig;

/// The original `Problem::new` (before the 2-D overlap test and the
/// derived problems), verbatim.
#[allow(clippy::needless_range_loop)]
fn reference_new(cols: Vec<Column>, bg: &BgBasis, n_px: usize, work: &mut u64) -> Problem {
    let n = cols.len();
    let k = bg.k;
    let mut gcc = vec![0.0f64; n * n];
    let mut buf = vec![0.0f32; n_px];
    let lo: Vec<u32> = cols
        .iter()
        .map(|c| c.pix.iter().copied().min().unwrap_or(0))
        .collect();
    let hi: Vec<u32> = cols
        .iter()
        .map(|c| c.pix.iter().copied().max().unwrap_or(0))
        .collect();
    let grid = cols.iter().find_map(|c| c.grid.clone());
    let nb = grid.as_ref().map_or(0, |g| g.len());
    // Per column: its moat as a dense block vector, and its support
    // part summed per block (`Σ_{p∈S∩B} val_p s_p`).
    let mut lo_i = vec![0.0f64; nb];
    let mut cs_i = vec![0.0f64; nb];
    let cs: Vec<Vec<(u32, f64)>> = match &grid {
        Some(g) => cols
            .iter()
            .map(|c| {
                let mut m: Vec<(u32, f64)> = Vec::new();
                for (&p, &v) in c.pix.iter().zip(&c.val) {
                    let b = g.of[p as usize];
                    let x = f64::from(v * g.s[p as usize]);
                    match m.iter_mut().rev().find(|e| e.0 == b) {
                        Some(e) => e.1 += x,
                        None => m.push((b, x)),
                    }
                }
                *work += c.pix.len() as u64;
                m
            })
            .collect(),
        None => Vec::new(),
    };
    for i in 0..n {
        for (&p, &v) in cols[i].pix.iter().zip(&cols[i].val) {
            buf[p as usize] = v;
        }
        if grid.is_some() {
            for (&b, &l) in cols[i].blk.iter().zip(&cols[i].low) {
                lo_i[b as usize] = f64::from(l);
            }
            for &(b, x) in &cs[i] {
                cs_i[b as usize] = x;
            }
        }
        for j in i..n {
            let mut d = 0.0f64;
            if !(cols[j].pix.is_empty() || lo[j] > hi[i] || hi[j] < lo[i]) {
                d += cols[j]
                    .pix
                    .iter()
                    .zip(&cols[j].val)
                    .map(|(&p, &v)| f64::from(buf[p as usize] * v))
                    .sum::<f64>();
                *work += cols[j].pix.len() as u64;
            }
            if let Some(g) = &grid {
                // − Σ_{S_j} val_j s low_i − Σ_{B_j} low_j cs_i + Σ low_i low_j V.
                if !cols[i].blk.is_empty() {
                    for &(b, x) in &cs[j] {
                        d -= x * lo_i[b as usize];
                    }
                }
                for (&b, &l) in cols[j].blk.iter().zip(&cols[j].low) {
                    let b = b as usize;
                    d += f64::from(l) * (lo_i[b] * g.v[b] - cs_i[b]);
                }
                *work += (cs[j].len() + cols[j].blk.len()) as u64;
            }
            gcc[i * n + j] = d;
            gcc[j * n + i] = d;
        }
        for &p in &cols[i].pix {
            buf[p as usize] = 0.0;
        }
        lo_i.iter_mut().for_each(|v| *v = 0.0);
        cs_i.iter_mut().for_each(|v| *v = 0.0);
    }
    // Background maps summed per block with the whitening.
    let mb: Vec<Vec<f64>> = match &grid {
        Some(g) => bg.maps.iter().map(|m| g.sums(m)).collect(),
        None => Vec::new(),
    };
    if grid.is_some() {
        *work += (k * n_px) as u64;
    }
    let mut gbc = vec![0.0f64; k * n];
    for (i, c) in cols.iter().enumerate() {
        for a in 0..k {
            let m = &bg.maps[a];
            gbc[a * n + i] = c
                .pix
                .iter()
                .zip(&c.val)
                .map(|(&p, &v)| f64::from(m[p as usize] * v))
                .sum();
            if let Some(z) = mb.get(a) {
                for (&b, &l) in c.blk.iter().zip(&c.low) {
                    gbc[a * n + i] -= f64::from(l) * z[b as usize];
                }
            }
        }
        *work += (k * c.pix.len()) as u64;
    }
    // T = G_cb G_bb⁻¹ ; Q = G_cc − T G_bc.
    let mut t = vec![0.0f64; n * k];
    for i in 0..n {
        for a in 0..k {
            t[i * k + a] = (0..k).map(|b| gbc[b * n + i] * bg.inv[b * k + a]).sum();
        }
    }
    let mut q = gcc.clone();
    for i in 0..n {
        for j in 0..n {
            let s: f64 = (0..k).map(|a| t[i * k + a] * gbc[a * n + j]).sum();
            q[i * n + j] -= s;
        }
    }
    *work += (n * n * k) as u64;
    Problem {
        cols: Arc::new(cols),
        n,
        k,
        t,
        q: Arc::new(q),
        gbc: Arc::new(gbc),
        mb: Arc::new(mb),
        bg_inv: bg.inv.clone(),
        bg: Arc::new(bg.clone()),
        grid,
        gcc: Arc::new(gcc),
        sig: 0,
    }
}

/// `n` cells with moats (some with a skirt) scattered over a 120 x 120
/// FOV with a non-uniform noise map, and a 72 x 80 patch that clips some.
pub(super) fn scene(n: usize) -> (Vec<Cell>, std::sync::Arc<PatchGrid>) {
    let dims = Dims {
        width: 120,
        height: 120,
    };
    let npx = 120 * 120;
    let mut fov = vec![1u8; npx];
    for (i, f) in fov.iter_mut().enumerate() {
        if i % 120 < 3 {
            *f = 0;
        }
    }
    let inv: Vec<f32> = (0..npx).map(|i| 0.5 + (i % 7) as f32 * 0.1).collect();
    let mut filter = LocalFilter::new(20.0);
    let cfg = LibraryConfig::default();
    let full = Rect {
        y0: 0,
        x0: 0,
        h: 120,
        w: 120,
    };
    let mut s = 12345u64;
    let mut rnd = move || {
        s = s
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((s >> 33) as f32) / (1u64 << 31) as f32
    };
    let mut cells = Vec::new();
    let mut id = 1;
    while cells.len() < n {
        let (cy, cx) = (8.0 + 104.0 * rnd(), 8.0 + 104.0 * rnd());
        let r = 4.0 + 3.0 * rnd();
        let a: Vec<f32> = (0..npx)
            .map(|i| {
                let (dy, dx) = ((i / 120) as f32 - cy, (i % 120) as f32 - cx);
                let r2 = dy * dy + dx * dx;
                if r2 < r * r * 1.6 {
                    (-r2 / (2.0 * r)).exp()
                } else {
                    0.0
                }
            })
            .collect();
        let skirt: Vec<(u32, f32)> = if id % 3 == 0 {
            let b = (cy as u32 / 8) * 15 + cx as u32 / 8;
            vec![(b, 0.02), (b + 1, -0.01)]
        } else {
            Vec::new()
        };
        if let Some(c) = Cell::from_canvas(
            id,
            full,
            &a,
            dims,
            &fov,
            &cfg,
            Extent::Given,
            &mut filter,
            &skirt,
        ) {
            cells.push(c);
        }
        id += 1;
    }
    let rect = Rect {
        y0: 20,
        x0: 14,
        h: 72,
        w: 80,
    };
    let grid = std::sync::Arc::new(PatchGrid::new(rect, dims, &inv, &fov, 8));
    (cells, grid)
}

pub(super) fn columns(
    cells: &[Cell],
    grid: &std::sync::Arc<PatchGrid>,
    skip: &[u64],
    extra: &[&Cell],
) -> Vec<Column> {
    let mut cols: Vec<Column> = cells
        .iter()
        .filter(|c| c.bbox.intersects(&grid.rect) && !skip.contains(&c.id))
        .map(|c| Column::of(c, grid, 120))
        .filter(|c| !c.pix.is_empty())
        .collect();
    for c in extra {
        cols.push(Column::of(c, grid, 120));
    }
    cols
}

pub(super) fn same(a: &Problem, b: &Problem) {
    let bits = |v: &[f64]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
    assert_eq!(a.n, b.n);
    assert_eq!(a.k, b.k);
    let ids = |p: &Problem| p.cols.iter().map(|c| c.id).collect::<Vec<_>>();
    assert_eq!(ids(a), ids(b));
    assert_eq!(bits(&a.q), bits(&b.q), "Q");
    assert_eq!(bits(&a.t), bits(&b.t), "T");
    assert_eq!(bits(&a.gbc), bits(&b.gbc), "G_bc");
    assert_eq!(bits(&a.bg_inv), bits(&b.bg_inv), "G_bb⁻¹");
}

#[test]
fn problem_new_matches_the_reference_bitwise() {
    let (cells, grid) = scene(40);
    let cols = columns(&cells, &grid, &[], &[]);
    assert!(cols.len() >= 15, "{} columns", cols.len());
    assert!(cols.iter().filter(|c| c.grid.is_some()).count() >= 10);
    let bg = BgBasis::new(grid.rect);
    let (mut w0, mut w1) = (0, 0);
    let a = reference_new(cols.clone(), &bg, grid.rect.len(), &mut w0);
    let b = Problem::new(cols.clone(), &bg, grid.rect.len(), &mut w1);
    same(&a, &b);
    assert_eq!(w0, w1, "work is counted as before");
    // Columns with no width (plain) fall back to the row test.
    let plain: Vec<Column> = cols
        .iter()
        .map(|c| Column {
            width: 0,
            ..c.clone()
        })
        .collect();
    let c = Problem::new(plain, &bg, grid.rect.len(), &mut w1);
    same(&a, &c);
}

#[test]
fn reused_problems_match_the_reference_bitwise() {
    let (all, grid) = scene(46);
    let (cells, more) = all.split_at(40);
    let bg = BgBasis::new(grid.rect);
    let bump: Vec<f32> = (0..grid.rect.len())
        .map(|p| {
            let (dy, dx) = ((p / 80) as f32 - 30.0, (p % 80) as f32 - 41.0);
            (-(dy * dy + dx * dx) / 50.0).exp()
        })
        .collect();
    let bg2 = bg.with_extra(&bump);
    let mut w = 0;
    let base = Problem::new(
        columns(cells, &grid, &[], &[]),
        &bg,
        grid.rect.len(),
        &mut w,
    );
    let ids: Vec<u64> = base.cols.iter().map(|c| c.id).collect();
    // A cell replaced in place (same id, other footprint).
    let mut moved = more[0].clone();
    moved.id = ids[3];
    let mut changed = cells.to_vec();
    let at = changed.iter().position(|c| c.id == ids[3]).unwrap();
    changed[at] = moved.clone();
    // The same patch grid rebuilt (not the same Arc).
    let inv: Vec<f32> = (0..120 * 120).map(|i| 0.5 + (i % 7) as f32 * 0.1).collect();
    let fov: Vec<u8> = (0..120 * 120).map(|i| u8::from(i % 120 >= 3)).collect();
    let dims = Dims {
        width: 120,
        height: 120,
    };
    let grid2 = std::sync::Arc::new(PatchGrid::new(grid.rect, dims, &inv, &fov, 8));
    type Case<'a> = (
        &'a [Cell],
        &'a std::sync::Arc<PatchGrid>,
        Vec<u64>,
        Vec<&'a Cell>,
        &'a BgBasis,
    );
    let cases: Vec<Case> = vec![
        (cells, &grid, vec![], vec![], &bg),
        (cells, &grid2, vec![], vec![], &bg2),
        (cells, &grid, vec![], vec![&more[1]], &bg2),
        (cells, &grid, vec![ids[2]], vec![], &bg2),
        (
            cells,
            &grid,
            vec![ids[2], ids[7]],
            vec![&more[1], &more[2]],
            &bg,
        ),
        (cells, &grid, vec![ids[5]], vec![&more[3]], &bg),
        (&changed, &grid, vec![], vec![], &bg),
        (&changed, &grid2, vec![ids[1]], vec![&more[4], &moved], &bg2),
    ];
    for (k, (cs, g, skip, extra, b)) in cases.into_iter().enumerate() {
        let cols = columns(cs, g, &skip, &extra);
        let (mut w0, mut w1) = (0, 0);
        let want = reference_new(cols.clone(), b, g.rect.len(), &mut w0);
        let got = Problem::new_reusing(cols, b, g.rect.len(), &mut w1, Some(&base.gram_ref()));
        same(&want, &got);
        assert_eq!(w0, w1, "case {k}: work is counted as before");
        // Chained: reusing a problem that was itself built by reuse.
        let cols = columns(cs, g, &[], &[]);
        let again = Problem::new_reusing(
            cols.clone(),
            b,
            g.rect.len(),
            &mut w1,
            Some(&got.gram_ref()),
        );
        same(&reference_new(cols, b, g.rect.len(), &mut w0), &again);
    }
}

/// The original `Column::of` (binary search for the moat level), verbatim.
fn reference_column(cell: &Cell, grid: &std::sync::Arc<PatchGrid>, width: usize) -> Column {
    let rect = grid.rect;
    let mut blk = Vec::new();
    let mut low = Vec::new();
    let mut gl: Vec<(u32, f32)> = Vec::new();
    if grid.block > 0 {
        for (&bq, &l) in cell.low_blk.iter().zip(&cell.low) {
            if let Some(lb) = grid.local(bq) {
                blk.push(lb);
                low.push(l);
                gl.push((bq, l));
            }
        }
    }
    let mut pix = Vec::new();
    let mut val = Vec::new();
    for (&g, &v) in cell.pix.iter().zip(&cell.filt) {
        let (gy, gx) = (g as usize / width, g as usize % width);
        if let Some(l) = rect.local(gy, gx) {
            let mut u = v;
            if let (Some(by), Some(bx)) = (gy.checked_div(grid.block), gx.checked_div(grid.block)) {
                let bq = (by * grid.gw + bx) as u32;
                if let Ok(k) = gl.binary_search_by_key(&bq, |e| e.0) {
                    u += gl[k].1;
                }
            }
            pix.push(l as u32);
            val.push(u * grid.s[l]);
        }
    }
    Column {
        id: cell.id,
        pix,
        val,
        grid: (grid.block > 0 && !blk.is_empty()).then(|| grid.clone()),
        blk,
        low,
        width: rect.w as u32,
    }
}

#[test]
fn column_of_matches_the_reference_bitwise() {
    let (cells, grid) = scene(40);
    let mut n = 0;
    for c in &cells {
        let (a, b) = (reference_column(c, &grid, 120), Column::of(c, &grid, 120));
        assert_eq!(a.pix, b.pix);
        assert!(bits_eq(&a.val, &b.val), "cell {}", c.id);
        assert_eq!(a.blk, b.blk);
        assert!(bits_eq(&a.low, &b.low));
        assert_eq!(a.grid.is_some(), b.grid.is_some());
        n += usize::from(!a.blk.is_empty() && !a.pix.is_empty());
    }
    assert!(n >= 10, "{n} columns with moats on the patch");
}
