//! The size of one spike in a cell's trace (the "unit"), estimated from the
//! trace itself. No assumed maximum firing rate enters anywhere.
//!
//! Statistic: one linear onset filter (least-squares amplitude of a kernel
//! starting at frame t, fitted with a constant and the kernel's two
//! exponentials on a window of the kernel's equivalent width, interpolated to
//! the real-valued width).
//!
//! Noise: each cell's noise sd of the filter output is read from its
//! main-lobe maxima (the white-noise law of those maxima is simulated through
//! the same filter), then pooled over the recording: the noise spectrum shape
//! is shared and read where the recording is least crowded ([`pool_noise`]).
//!
//! Unit: nested isolated extrema of the filter output ([`picks`]), with
//! windows cut short where a larger neighbour overlaps. The negative picks
//! give the null law; the positive ones are noise or events under a mixture
//! likelihood with a geometric count law and a selection term. Per cell: unit
//! and count-law parameter. Per recording (shared, by the summed
//! log-likelihood): level exponent q, gain spread, level spread ([`combos`]).
//!
//! Every cell gets a finite positive unit; a cell that cannot be fitted takes
//! its largest pick. [`recording`] is the entry point.
use std::cell::RefCell;
use std::rc::Rc;

pub const QG: [f64; 5] = [1.0, 1.4, 1.8, 2.2, 2.6];
pub const GG: [f64; 3] = [0.05, 0.15, 0.3];
pub const SG: [f64; 2] = [0.2, 0.4];
pub const NCOMBO: usize = 30;
const NU: usize = 70;
const NSITE: usize = 6000;
// sqrt(2 pi) and 2 pi to ten digits, as in the reference implementation the estimator was validated against;
// kept so the results match it exactly.
const SQ2PI: f64 = 2.5066282746;
#[allow(clippy::approx_constant)]
const TWO_PI: f64 = 6.283185307;

/// The 30 shared combinations (q, gamma, s).
pub fn combos() -> Vec<(f64, f64, f64)> {
    let mut v = Vec::with_capacity(NCOMBO);
    for &q in &QG {
        for &g in &GG {
            for &s in &SG {
                v.push((q, g, s));
            }
        }
    }
    v
}

fn linspace(a: f64, b: f64, n: usize) -> Vec<f64> {
    let step = (b - a) / (n - 1) as f64;
    let mut v: Vec<f64> = (0..n).map(|i| i as f64 * step + a).collect();
    v[n - 1] = b;
    v
}

fn rho_grid() -> Vec<f64> {
    linspace(0.05, 0.95, 13)
}

// ---------- normal distribution ----------

fn erf_series(x: f64) -> f64 {
    // erf(x) = 2/sqrt(pi) exp(-x^2) sum_n 2^n x^(2n+1) / (2n+1)!!  (positive terms)
    let x2 = x * x;
    let mut term = x;
    let mut sum = x;
    let mut n = 1.0;
    loop {
        term *= 2.0 * x2 / (2.0 * n + 1.0);
        sum += term;
        if term <= sum * 1e-17 {
            break;
        }
        n += 1.0;
        if n > 500.0 {
            break;
        }
    }
    2.0 / std::f64::consts::PI.sqrt() * (-x2).exp() * sum
}

fn erfc_cf(x: f64) -> f64 {
    // modified Lentz on erfc(x) = exp(-x^2)/sqrt(pi) / (x + (1/2)/(x + 1/(x + (3/2)/(x + ...))))
    let tiny = 1e-300;
    let mut f = x;
    let mut c = x;
    let mut d = 0.0;
    for k in 1..2000 {
        let a = k as f64 * 0.5;
        d = x + a * d;
        if d.abs() < tiny {
            d = tiny;
        }
        d = 1.0 / d;
        c = x + a / c;
        if c.abs() < tiny {
            c = tiny;
        }
        let delta = c * d;
        f *= delta;
        if (delta - 1.0).abs() < 1e-16 {
            break;
        }
    }
    (-x * x).exp() / std::f64::consts::PI.sqrt() / f
}

/// erfc for x >= 0.
fn erfc_pos(x: f64) -> f64 {
    if x < 2.5 {
        1.0 - erf_series(x)
    } else {
        erfc_cf(x)
    }
}

/// Standard normal cdf.
pub fn ndtr(z: f64) -> f64 {
    if z.is_nan() {
        return f64::NAN;
    }
    let t = z / std::f64::consts::SQRT_2;
    if t < 0.0 {
        0.5 * erfc_pos(-t)
    } else {
        1.0 - 0.5 * erfc_pos(t)
    }
}

// ---------- numpy helpers ----------

/// numpy median: middle value, or the mean of the two middle values.
pub(crate) fn median(v: &[f64]) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let n = s.len();
    if n % 2 == 1 {
        s[n / 2]
    } else {
        (s[n / 2 - 1] + s[n / 2]) / 2.0
    }
}

/// numpy arange values: start + i * ((start + step) - start).
fn arange(start: f64, step: f64, n: usize) -> Vec<f64> {
    let delta = (start + step) - start;
    (0..n).map(|i| start + i as f64 * delta).collect()
}

/// numpy quantile, default 'linear' method.
fn quantile(v: &[f64], q: f64) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    quantile_sorted(&s, q)
}

fn quantile_sorted(s: &[f64], q: f64) -> f64 {
    let n = s.len();
    let pos = q * (n - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = (lo + 1).min(n - 1);
    let g = pos - lo as f64;
    // numpy: lerp(a, b, t) = a + (b - a) t, with the t >= 0.5 branch b - (b - a)(1 - t)
    let (a, b) = (s[lo], s[hi]);
    let d = b - a;
    if g >= 0.5 {
        b - d * (1.0 - g)
    } else {
        a + d * g
    }
}

/// numpy interp for increasing xp; left value given, right = fp[-1].
fn interp(x: f64, xp: &[f64], fp: &[f64], left: f64) -> f64 {
    let n = xp.len();
    if x.is_nan() {
        return f64::NAN;
    }
    if x < xp[0] {
        return left;
    }
    if x > xp[n - 1] {
        return fp[n - 1];
    }
    if x == xp[n - 1] {
        return fp[n - 1];
    }
    // last j with xp[j] <= x
    let j = xp.partition_point(|&v| v <= x) - 1;
    let slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
    let r = slope * (x - xp[j]) + fp[j];
    if r.is_nan() {
        // numpy: fall back to the other end if slope*(x-xp) is nan
        let r2 = slope * (x - xp[j + 1]) + fp[j + 1];
        if r2.is_nan() && fp[j] == fp[j + 1] {
            return fp[j];
        }
        return r2;
    }
    r
}

// ---------- kernel and filter ----------

/// The kernel on the frame grid, peak 1, k[0] = 0; the two decay factors.
pub fn kern_blind(tr: f64, td: f64, fs: f64) -> (Vec<f64>, f64, f64) {
    let a = (-1.0 / (td * fs)).exp();
    let b = (-1.0 / (tr * fs)).exp();
    let l = (td * fs * 1e4_f64.ln()).ceil() as usize + 3;
    let mut k: Vec<f64> = (0..l)
        .map(|j| a.powf(j as f64) - b.powf(j as f64))
        .collect();
    let mx = k.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    k.iter_mut().for_each(|v| *v /= mx);
    (k, a, b)
}

/// Equivalent width of the kernel in frames.
pub fn neq(k: &[f64]) -> usize {
    let s: f64 = k.iter().sum();
    let s2: f64 = k.iter().map(|v| v * v).sum();
    (s * s / s2).ceil() as usize
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Onset filter: row 0 of the pseudo-inverse of [template, 1, a^(j+m), b^(j+m)]
/// on [t - n, t + n): the residual of the template after projection on the
/// other three columns, divided by its squared norm. Returns (w, m).
pub fn onset_filter(k: &[f64], a: f64, b: f64) -> (Vec<f64>, usize) {
    let n = neq(k);
    (window_filter(k, a, b, n, n), n)
}

/// The same least-squares amplitude on the window [t - m, t + l) (windows cut by a larger neighbour).
fn window_filter(k: &[f64], a: f64, b: f64, m: usize, l: usize) -> Vec<f64> {
    let len = m + l;
    let tm: Vec<f64> = (0..len)
        .map(|i| {
            let j = i as isize - m as isize;
            if j >= 0 {
                k[(j as usize).min(k.len() - 1)]
            } else {
                0.0
            }
        })
        .collect();
    let cols: Vec<Vec<f64>> = vec![
        vec![1.0; len],
        (0..len).map(|i| a.powf(i as f64)).collect(),
        (0..len).map(|i| b.powf(i as f64)).collect(),
    ];
    // Gram-Schmidt with re-orthogonalization.
    let mut q: Vec<Vec<f64>> = Vec::new();
    for c in cols {
        let mut v = c;
        for _ in 0..2 {
            for qq in &q {
                let p = dot(qq, &v);
                v.iter_mut().zip(qq).for_each(|(x, y)| *x -= p * y);
            }
        }
        let nv = dot(&v, &v).sqrt();
        if nv > 1e-300 {
            v.iter_mut().for_each(|x| *x /= nv);
            q.push(v);
        }
    }
    let mut r = tm.clone();
    for _ in 0..2 {
        for qq in &q {
            let p = dot(qq, &r);
            r.iter_mut().zip(qq).for_each(|(x, y)| *x -= p * y);
        }
    }
    let rr = dot(&r, &tm);
    r.iter().map(|v| v / rr).collect()
}

/// a(t) = sum_i w[i] y[t - m + i]; NaN where the window does not fit.
pub fn apply(w: &[f64], m: usize, y: &[f64]) -> Vec<f64> {
    let (t, wl) = (y.len(), w.len());
    let mut out = vec![f64::NAN; t];
    if t < wl {
        return out;
    }
    for i in 0..=(t - wl) {
        let mut s = 0.0;
        for (j, &wj) in w.iter().enumerate() {
            s += y[i + j] * wj;
        }
        out[m + i] = s;
    }
    out
}

fn response(w: &[f64], m: usize, k: &[f64], span: usize) -> Vec<f64> {
    let nz = 2 * (w.len() + k.len()) + 2 * span + 1;
    let mut z = vec![0.0; nz];
    let c = nz / 2 - k.len() / 2;
    for (i, &v) in k.iter().enumerate() {
        if c + i < nz {
            z[c + i] = v;
        }
    }
    let a = apply(w, m, &z);
    a[c - span..c + span + 1].to_vec()
}

/// Half-width of the positive main lobe of the response to one event.
pub fn lobe(w: &[f64], m: usize, k: &[f64]) -> usize {
    let r = response(w, m, k, w.len());
    let c = w.len();
    let mut up = 1;
    while up < c && r[c + up] > 0.0 {
        up += 1;
    }
    let mut dn = 1;
    while dn < c && r[c - dn] > 0.0 {
        dn += 1;
    }
    (up.max(dn) - 1).max(1)
}

/// Local maxima that are the largest value within r frames either side
/// (scipy maximum_filter1d, constant -inf outside). Returns indices.
fn peaks_idx(a: &[f64], r: usize) -> Vec<usize> {
    let n = a.len();
    let x: Vec<f64> = a
        .iter()
        .map(|&v| if v.is_finite() { v } else { f64::NEG_INFINITY })
        .collect();
    // sliding max over [i - r, i + r] with a monotone deque
    let mut mx = vec![f64::NEG_INFINITY; n];
    let mut dq: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
    let mut next = 0usize; // next index to push
    for i in 0..n {
        let hi = (i + r).min(n - 1);
        while next <= hi {
            while let Some(&b) = dq.back() {
                if x[b] <= x[next] {
                    dq.pop_back();
                } else {
                    break;
                }
            }
            dq.push_back(next);
            next += 1;
        }
        while let Some(&f) = dq.front() {
            if f + r < i {
                dq.pop_front();
            } else {
                break;
            }
        }
        mx[i] = x[*dq.front().unwrap()];
    }
    (0..n)
        .filter(|&i| x[i] == mx[i] && a[i].is_finite() && i > r && i + r + 1 < n)
        .collect()
}

fn peaks(a: &[f64], r: usize) -> Vec<f64> {
    peaks_idx(a, r).into_iter().map(|i| a[i]).collect()
}

/// Signed isolated extrema: |a| largest within r frames either side.
fn extrema(a: &[f64], r: usize) -> Vec<f64> {
    let ab: Vec<f64> = a.iter().map(|v| v.abs()).collect();
    peaks_idx(&ab, r).into_iter().map(|i| a[i]).collect()
}

// ---------- generator for the white-noise sample of the null table ----------

/// Seed of the white-noise sample behind [`Tables`]. Fixed on purpose: the table (and `ne_white`, which a recording
/// with no cell at 5 negative extrema falls back on) must be the same on every machine and run, so the same data
/// always give the same unit. The generator below is integer arithmetic plus `ln`, `sin`, `cos`.
const NULL_SEED: u64 = 1;

fn normals(n: usize, seed: u64) -> Vec<f64> {
    // splitmix64 + Box-Muller (both outputs)
    let mut s = seed;
    let mut next = move || {
        s = s.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = s;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        ((z >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    };
    let mut v = Vec::with_capacity(n + 1);
    while v.len() < n {
        let (u1, u2) = (next(), next());
        let r = (-2.0 * u1.ln()).sqrt();
        let t = 2.0 * std::f64::consts::PI * u2;
        v.push(r * t.cos());
        v.push(r * t.sin());
    }
    v.truncate(n);
    v
}

// ---------- laws ----------

/// Stage 1: law of the main-lobe maxima of white noise through the filter.
pub struct Tables {
    hg: Vec<f64>,
    lf: Vec<f64>,
    hc: f64,
    lfc: f64,
    pub q0: [f64; 3],
    ag: Vec<f64>,
    d: Vec<f64>,
    mu: Vec<f64>,
    sd: Vec<f64>,
    pub ne_white: f64,
}

impl Tables {
    pub fn new(w: &[f64], m: usize, k: &[f64], r: usize) -> Tables {
        let wl = w.len();
        let span = wl + 4 * r + 4;
        let e = normals(NSITE * span + wl, NULL_SEED);
        let wn = dot(w, w).sqrt();
        let a: Vec<f64> = apply(w, m, &e).iter().map(|v| v / wn).collect();
        let h0 = peaks(&a, r);
        let hg = arange(-2.0, 0.05, 161);
        let mut edges: Vec<f64> = hg.iter().map(|v| v - 0.025).collect();
        edges.push(hg[160] + 0.025);
        let mut cnt = vec![0.0; 161];
        for &h in &h0 {
            if h < edges[0] || h > edges[161] {
                continue;
            }
            let mut b = edges.partition_point(|&e| e <= h) - 1;
            if b >= 161 {
                b = 160;
            }
            cnt[b] += 1.0;
        }
        let bw = 0.12;
        let mut ker: Vec<f64> = (-12..13)
            .map(|i| (-0.5 * (i as f64 * 0.05 / bw).powi(2)).exp())
            .collect();
        let ks: f64 = ker.iter().sum();
        ker.iter_mut().for_each(|v| *v /= ks);
        let norm = h0.len() as f64 * 0.05;
        let den: Vec<f64> = (0..161)
            .map(|i| {
                let mut s = 0.0;
                for (j, &kv) in ker.iter().enumerate() {
                    let idx = i as isize + 12 - j as isize;
                    if idx >= 0 && (idx as usize) < 161 {
                        s += cnt[idx as usize] * kv;
                    }
                }
                s / norm
            })
            .collect();
        let mut hs = h0.clone();
        hs.sort_by(|a, b| a.total_cmp(b));
        let hc = quantile_sorted(&hs, 0.995);
        let lf: Vec<f64> = den.iter().map(|v| (v + 1e-300).ln()).collect();
        let lfc = interp(hc, &hg, &lf, f64::NAN);
        let q0 = [
            quantile_sorted(&hs, 0.25),
            quantile_sorted(&hs, 0.5),
            quantile_sorted(&hs, 0.75),
        ];
        let resp = response(w, m, k, 2 * r);
        let ag = arange(0.0, 0.25, 49);
        let (mut d, mut mu, mut sd) = (vec![0.0; 49], vec![0.0; 49], vec![1.0; 49]);
        let wseg = 4 * r + 1;
        let mut z = vec![0.0; wseg];
        for (ia, &aa) in ag.iter().enumerate() {
            let (mut nok, mut s1, mut hv) = (0usize, 0.0, Vec::with_capacity(NSITE));
            for i in 0..NSITE {
                let c = m + span / 2 + i * span;
                for q in 0..wseg {
                    z[q] = a[c - 2 * r + q] + aa * resp[q];
                }
                let mut im = 0;
                for q in 1..=2 * r {
                    if z[r + q] > z[r + im] {
                        im = q;
                    }
                }
                let h = z[r + im];
                let nb = z[im..=im + 2 * r]
                    .iter()
                    .cloned()
                    .fold(f64::NEG_INFINITY, f64::max);
                if h >= nb {
                    nok += 1;
                    s1 += h;
                    hv.push(h);
                }
            }
            d[ia] = nok as f64 / NSITE as f64;
            let mean = s1 / nok as f64;
            mu[ia] = mean;
            sd[ia] = (hv.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / nok as f64).sqrt();
        }
        let ea: Vec<f64> = extrema(&a, neq(k)).iter().map(|v| v.abs()).collect();
        let ne_white = 0.5_f64.ln() / (2.0 * ndtr(median(&ea)) - 1.0).ln();
        Tables {
            hg,
            lf,
            hc,
            lfc,
            q0,
            ag,
            d,
            mu,
            sd,
            ne_white,
        }
    }

    fn f0(&self, h: f64) -> f64 {
        let out = if h > self.hc {
            self.lfc + (h / self.hc).ln() - 0.5 * (h * h - self.hc * self.hc)
        } else {
            interp(h, &self.hg, &self.lf, -700.0)
        };
        out.exp()
    }
}

/// Null and selection term of the full windows: extreme |value| of noise = largest of ne N(0,1).
struct Signed {
    ne: f64,
    zg: Vec<f64>,
    g0g: Vec<f64>,
}

impl Signed {
    fn new(ne: f64) -> Signed {
        let zg = arange(0.025, 0.05, 280);
        let mut s = Signed {
            ne,
            zg,
            g0g: vec![],
        };
        s.g0g = s.zg.iter().map(|&z| s.g0(z)).collect();
        s
    }
    fn g0(&self, h: f64) -> f64 {
        (2.0 * ndtr(h.max(0.0)) - 1.0).powf(self.ne)
    }
    /// D(A): chance that an event of amplitude `a` (sd `sdev`) beats the noise extreme.
    fn dn(&self, a: f64, sdev: f64) -> f64 {
        let ztop = self.zg[279] + 0.025;
        let mut pg = 0.0;
        for g in 0..280 {
            let e = (self.zg[g] - a) / sdev;
            pg += (-0.5 * e * e).exp() / (SQ2PI * sdev) * self.g0g[g] * 0.05;
        }
        let tb = 1.0 - ndtr((ztop - a) / sdev);
        (pg + tb).max(1e-12)
    }
}

/// Event sizes carried by the sum: 1..12, then log-spaced bins (ratio 1.25) up to `top`.
fn nodes(top: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let mut n: Vec<f64> = (1..13).map(|v| v as f64).collect();
    let mut lo: Vec<f64> = (1..13).map(|v| v as f64).collect();
    let mut hi: Vec<f64> = (2..14).map(|v| v as f64).collect();
    let mut e = 13usize;
    while e <= top {
        let h2 = ((e as f64 * 1.25).ceil() as usize).max(e + 1);
        n.push((e as f64 * (h2 as f64 - 1.0)).sqrt());
        lo.push(e as f64);
        hi.push(h2 as f64);
        e = h2;
    }
    (n, lo, hi)
}

fn levels_pow(nn: f64, q: f64, g: f64, s: f64) -> (f64, f64) {
    let cv = (g * g / nn + if nn > 1.5 { s * s } else { 0.0 }).sqrt();
    (nn.powf(q), cv)
}

/// The unit scan (in noise sd, up to the largest height `zt`) and the event sizes it carries: (ug, node sizes, lo, hi, levels, cv).
#[allow(clippy::type_complexity)]
fn scan(
    zt: f64,
    lev: (f64, f64, f64),
) -> (Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>) {
    let ug: Vec<f64> = linspace(0.0, zt.ln(), NU).iter().map(|v| v.exp()).collect();
    let (nn0, lo0, hi0) = nodes(1000);
    let (mut nn, mut lo, mut hi, mut lv, mut cvv) = (vec![], vec![], vec![], vec![], vec![]);
    for i in 0..nn0.len() {
        let (l, cv) = levels_pow(nn0[i], lev.0, lev.1, lev.2);
        let amin = ug.iter().map(|u| u * l).fold(f64::INFINITY, f64::min);
        if amin < 3.0 * zt + 10.0 || nn0[i] <= 12.0 {
            nn.push(nn0[i]);
            lo.push(lo0[i]);
            hi.push(hi0[i]);
            lv.push(l);
            cvv.push(cv);
        }
    }
    (ug, nn, lo, hi, lv, cvv)
}

/// Log-likelihood of the main-lobe maxima x at noise sd `sig`, maximised over the count-law parameter and the empty
/// share, for every unit of the scan.
fn profile(x: &[f64], sig: f64, lev: (f64, f64, f64), t: &Tables) -> Vec<f64> {
    let z: Vec<f64> = x.iter().map(|v| v / sig).collect();
    let n = z.len();
    let zmax = z.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let zt = zmax.max(2.0);
    let (ug, nn, lo, hi, lv, cvv) = scan(zt, lev);
    let nk = nn.len();
    let nu = ug.len();
    // comp[u][k][i], d[u][k]
    let mut comp = vec![0.0; nu * nk * n];
    let mut dd = vec![1.0; nu * nk];
    let f0: Vec<f64> = z.iter().map(|&h| t.f0(h)).collect();
    for u in 0..nu {
        for k in 0..nk {
            let a = ug[u] * lv[k];
            let extra = if nn[k] > 12.0 { 0.25 * 0.29 } else { 0.0 };
            let cva = ((cvv[k] * a).powi(2) + (extra * a).powi(2)).sqrt();
            let am = a.min(12.0);
            let d = interp(am, &t.ag, &t.d, t.d[0]);
            let mut mu = interp(am, &t.ag, &t.mu, t.mu[0]);
            let sd = interp(am, &t.ag, &t.sd, t.sd[0]);
            mu += (a - 12.0).max(0.0);
            let sdev = (sd * sd + cva * cva).sqrt();
            dd[u * nk + k] = d;
            let base = (u * nk + k) * n;
            for i in 0..n {
                let e = (z[i] - mu) / sdev;
                comp[base + i] = (-0.5 * e * e).exp() / (SQ2PI * sdev);
            }
        }
    }
    let mut best = vec![f64::NEG_INFINITY; nu];
    let mut ev = vec![0.0; n];
    let mut wn = vec![0.0; nk];
    for &rho in &rho_grid() {
        for u in 0..nu {
            let mut sw = 0.0;
            for k in 0..nk {
                wn[k] = (rho.powf(lo[k] - 1.0) - rho.powf(hi[k] - 1.0)) * dd[u * nk + k];
                sw += wn[k];
            }
            ev.iter_mut().for_each(|v| *v = 0.0);
            for k in 0..nk {
                let wk = wn[k] / sw;
                let base = (u * nk + k) * n;
                for i in 0..n {
                    ev[i] += wk * comp[base + i];
                }
            }
            ev.iter_mut().for_each(|v| *v += 1e-300);
            let mut pp = 0.7;
            for _ in 0..25 {
                let mut rs = 0.0;
                for i in 0..n {
                    let a0 = pp * f0[i];
                    rs += a0 / (a0 + (1.0 - pp) * ev[i]);
                }
                pp = (rs / n as f64).clamp(1e-4, 1.0 - 1e-4);
            }
            let mut l = 0.0;
            for i in 0..n {
                l += (pp * f0[i] + (1.0 - pp) * ev[i]).ln();
            }
            let ll = l - n as f64 * sig.ln();
            if ll > best[u] {
                best[u] = ll;
            }
        }
    }
    best
}

/// Largest maximiser of the scan, refined by a parabola in log unit.
fn pick(u: &[f64], ll: &[f64]) -> (f64, usize) {
    let n = ll.len();
    // numpy argmax of reversed array: first max from the end; NaN wins in numpy argmax
    let mut i = n - 1;
    let mut bv = ll[n - 1];
    for j in (0..n).rev() {
        if ll[j].is_nan() {
            i = j;
            break;
        }
        if ll[j] > bv {
            bv = ll[j];
            i = j;
        }
    }
    if ll[n - 1].is_nan() {
        i = n - 1;
    }
    if i > 0 && i < n - 1 {
        let (a, b, c) = (ll[i - 1], ll[i], ll[i + 1]);
        let den = a - 2.0 * b + c;
        if den < 0.0 {
            return (
                (u[i].ln() + 0.5 * (a - c) / den * (u[i + 1].ln() - u[i].ln())).exp(),
                i,
            );
        }
    }
    (u[i], i)
}

fn argmax_first(v: &[f64]) -> usize {
    let mut i = 0;
    for j in 1..v.len() {
        if v[j].is_nan() {
            return j;
        }
        if v[j] > v[i] {
            i = j;
        }
    }
    i
}

fn vmax(v: &[f64]) -> f64 {
    if v.iter().any(|x| x.is_nan()) {
        return f64::NAN;
    }
    v.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
}

fn sigma_scan(x: &[f64], tab: &Tables, sig0: f64) -> f64 {
    let lev = (1.8, 0.15, 0.4);
    let mut g: Vec<f64> = linspace(-0.6, 0.4, 11)
        .iter()
        .map(|v| sig0 * v.exp())
        .collect();
    let mut v: Vec<f64> = g.iter().map(|&s| vmax(&profile(x, s, lev, tab))).collect();
    let mut i = argmax_first(&v);
    for _ in 0..6 {
        if i == 0 {
            let s = g[0] * (-0.1_f64).exp();
            g.insert(0, s);
            v.insert(0, vmax(&profile(x, s, lev, tab)));
        } else if i == g.len() - 1 {
            let s = g[g.len() - 1] * 0.1_f64.exp();
            g.push(s);
            v.push(vmax(&profile(x, s, lev, tab)));
        } else {
            break;
        }
        i = argmax_first(&v);
    }
    g[i]
}

/// The filters of one kernel and the null table.
pub struct Setup {
    pub k: Vec<f64>,
    /// The onset filter on the integer window (n, n): the noise reading and the reach use this one.
    pub w: Vec<f64>,
    pub m: usize,
    pub r1: usize,
    pub r2: usize,
    pub tab: Tables,
    /// The kernel's two per-frame decay factors.
    pub ab: (f64, f64),
    /// The filter the unit is read with: `w` interpolated to the kernel's real-valued equivalent width
    /// (`Win::get(n, n)`).
    pub wu: Vec<f64>,
}

impl Setup {
    pub fn new(tr: f64, td: f64, fs: f64) -> Setup {
        let (k, a, b) = kern_blind(tr, td, fs);
        let (w, m) = onset_filter(&k, a, b);
        let r1 = lobe(&w, m, &k);
        let r2 = neq(&k);
        let tab = Tables::new(&w, m, &k, r1);
        let wu = Win::new(&k, a, b)
            .get(r2, r2)
            .map_or(w.clone(), |r| r.0.clone());
        Setup {
            k,
            w,
            m,
            r1,
            r2,
            tab,
            ab: (a, b),
            wu,
        }
    }
}

thread_local! {
    static CACHE: RefCell<Option<((u64, u64, u64), Rc<Setup>)>> = const { RefCell::new(None) };
}

/// The setup for a kernel, cached per thread (the table costs a simulation).
pub fn setup_for(tr: f64, td: f64, fs: f64) -> Rc<Setup> {
    let key = (tr.to_bits(), td.to_bits(), fs.to_bits());
    CACHE.with(|c| {
        if let Some((k, s)) = c.borrow().as_ref() {
            if *k == key {
                return s.clone();
            }
        }
        let s = Rc::new(Setup::new(tr, td, fs));
        *c.borrow_mut() = Some((key, s.clone()));
        s
    })
}

/// The noise reading of one cell.
#[derive(Clone, Debug, Default)]
pub struct Stage1 {
    /// Noise sd of the unit filter's output (NaN when it cannot be fitted); replaced by the pooled reading in
    /// [`pool_noise`].
    pub sig: f64,
    /// White (frame) noise sd of the raw trace x |w| (median absolute first difference x 1.4826 / sqrt 2).
    pub white: f64,
    /// Share of the cell's reach windows free of a visible event.
    pub pfree: f64,
    /// The cell's own reading on the integer window, before pooling.
    pub sig_own: f64,
    /// Norm of the unit filter over the norm of the integer-window filter: the noise sd of the unit filter's output
    /// is the integer-window reading times this.
    pub wscale: f64,
}

/// Smallest rms of the finite values of `a` over any stretch of `b` consecutive ones (NaN when there is no full
/// stretch).
fn slide_min(a: &[f64], b: usize) -> f64 {
    let v: Vec<f64> = a.iter().copied().filter(|x| x.is_finite()).collect();
    if v.len() <= b {
        return f64::NAN;
    }
    let mut c = Vec::with_capacity(v.len() + 1);
    c.push(0.0);
    let mut s = 0.0;
    for x in &v {
        s += x * x;
        c.push(s);
    }
    let mut best = f64::INFINITY;
    for i in 0..=(v.len() - b) {
        best = best.min(c[i + b] - c[i]);
    }
    (best.max(0.0) / b as f64).sqrt()
}

/// Calibration of the quietest-stretch reading for the noise's colour. Noise family: white + random walk of
/// relative step lam. For each lam the same procedure is simulated (white level from the frame differences, the
/// filter, the minimum of the sliding 2n-frame rms) and gives, in white units, the median minimum `m` and the true
/// sd of the filter output `r`. lam = 0 is plain white noise. The grid of lam is numerical resolution.
fn quiet_curves(w: &[f64], m: usize, n: usize, t: usize) -> (Vec<f64>, Vec<f64>) {
    const REPS: usize = 100;
    let mut lam = vec![0.0];
    lam.extend((0..15).map(|i| 10f64.powf(-3.0 + 3.5 * i as f64 / 14.0)));
    let wn = dot(w, w).sqrt();
    let (mut mc, mut rc) = (Vec::new(), Vec::new());
    for (i, &l) in lam.iter().enumerate() {
        let (mut tm, mut rr) = (Vec::with_capacity(REPS), Vec::with_capacity(REPS));
        for j in 0..REPS {
            let z = normals(2 * t, NULL_SEED + 1 + (i * REPS + j) as u64);
            let mut walk = 0.0;
            let e: Vec<f64> = (0..t)
                .map(|q| {
                    walk += z[t + q];
                    z[q] + l * walk
                })
                .collect();
            let a = apply(w, m, &e);
            let sc = white_sd(&e) * wn;
            let f: Vec<f64> = a.iter().copied().filter(|x| x.is_finite()).collect();
            let mu = f.iter().sum::<f64>() / f.len().max(1) as f64;
            let sd =
                (f.iter().map(|x| (x - mu) * (x - mu)).sum::<f64>() / f.len().max(1) as f64).sqrt();
            tm.push(slide_min(&a, 2 * n) / sc);
            rr.push(sd / sc);
        }
        let prev = mc.last().copied().unwrap_or(f64::NEG_INFINITY);
        mc.push(median(&tm).max(prev));
        rc.push(median(&rr));
    }
    (mc, rc)
}

thread_local! {
    static QUIET: RefCell<Option<((usize, u64, usize, usize), Rc<(Vec<f64>, Vec<f64>)>)>> = const { RefCell::new(None) };
}

fn quiet_curves_for(st: &Setup, t: usize) -> Rc<(Vec<f64>, Vec<f64>)> {
    let key = (st.w.len(), dot(&st.w, &st.w).to_bits(), st.r2, t);
    QUIET.with(|c| {
        if let Some((k, v)) = c.borrow().as_ref() {
            if *k == key {
                return v.clone();
            }
        }
        let v = Rc::new(quiet_curves(&st.w, st.m, st.r2, t));
        *c.borrow_mut() = Some((key, v.clone()));
        v
    })
}

/// Observed minimum (white units) -> noise sd of the filter output (white units): `r` at the lam where `m` equals
/// it, log-interpolated; outside the curves the nearest ratio is kept.
fn quiet_shape(t: f64, mc: &[f64], rc: &[f64]) -> f64 {
    let last = mc.len() - 1;
    if !t.is_finite() || t <= 0.0 {
        return f64::NAN;
    }
    if t <= mc[0] {
        return t * rc[0] / mc[0];
    }
    if t >= mc[last] {
        return t * rc[last] / mc[last];
    }
    let i = (1..=last).find(|&i| t <= mc[i]).unwrap_or(last);
    if mc[i] <= mc[i - 1] {
        return rc[i];
    }
    let f = (t.ln() - mc[i - 1].ln()) / (mc[i].ln() - mc[i - 1].ln());
    (rc[i - 1].ln() + f * (rc[i].ln() - rc[i - 1].ln())).exp()
}

/// The cell's own noise reading: the quietest stretch of the filter output. Noise is in every stretch at one level
/// and signal only adds to it, so the stretch of the window's length (2n frames) with the least energy is the least
/// contaminated one; its rms is calibrated for the noise's colour ([`quiet_curves`]).
pub fn stage1_cell(trace: &[f64], st: &Setup) -> Stage1 {
    let a = apply(&st.w, st.m, trace);
    let (npos, nn, nfin) = sign_counts(&a, st.r2);
    let kap = ((npos - nn) * (2 * st.r2 + 1) as f64 / (nfin.max(1)) as f64)
        .max(0.0)
        .min(1.0 - 1.0 / (npos + 1.0));
    let wn = dot(&st.w, &st.w).sqrt();
    let white = white_sd(trace) * wn;
    let sig = if white.is_finite() && white > 0.0 {
        let cv = quiet_curves_for(st, trace.len());
        white * quiet_shape(slide_min(&a, 2 * st.r2) / white, &cv.0, &cv.1)
    } else {
        f64::NAN
    };
    let wscale = dot(&st.wu, &st.wu).sqrt() / wn;
    Stage1 {
        sig: sig * wscale,
        white,
        pfree: 1.0 - kap,
        sig_own: sig,
        wscale,
    }
}

/// Positive and negative isolated extrema of a filter output and its finite frames (the crowding index's inputs).
fn sign_counts(a: &[f64], r: usize) -> (f64, f64, usize) {
    let e = extrema(a, r);
    (
        e.iter().filter(|&&v| v > 0.0).count() as f64,
        e.iter().filter(|&&v| v < 0.0).count() as f64,
        a.iter().filter(|v| v.is_finite()).count(),
    )
}

/// Null parameter from the median negative extremum: (2 Phi(med/sig) - 1)^ne = 1/2 (NaN when it cannot be formed).
fn ne_of(negmed: f64, sig: f64) -> f64 {
    if !(sig.is_finite() && sig > 0.0 && negmed.is_finite()) {
        return f64::NAN;
    }
    let f = 2.0 * ndtr(negmed / sig) - 1.0;
    if f > 0.0 && f < 1.0 {
        0.5_f64.ln() / f.ln()
    } else {
        f64::NAN
    }
}

/// White (frame) noise sd of a raw trace: median absolute deviation of the first differences x 1.4826 / sqrt 2 (NaN-free values only).
fn white_sd(y: &[f64]) -> f64 {
    let d: Vec<f64> = y
        .windows(2)
        .map(|p| p[1] - p[0])
        .filter(|v| v.is_finite())
        .collect();
    if d.is_empty() {
        return f64::NAN;
    }
    let md = median(&d);
    let ad: Vec<f64> = d.iter().map(|v| (v - md).abs()).collect();
    1.4826 * median(&ad) / 2.0_f64.sqrt()
}

/// The recording-level noise reading. The kernel-band noise of the filter output is sig_c = white_c x rho, with the
/// reddening rho (noise spectrum shape) shared by the recording and read where the recording is least crowded: the
/// median of the cells' own readings sig_c / white_c weighted by the share of their reach windows free of a visible
/// event. Only cells with an own reading are changed. Returns rho (NaN when no cell has a reading; nothing is
/// changed then).
pub fn pool_noise(s1: &mut [Stage1]) -> f64 {
    let mut v: Vec<(f64, f64)> = s1
        .iter()
        .filter(|s| {
            s.sig_own.is_finite() && s.sig_own > 0.0 && s.white.is_finite() && s.white > 0.0
        })
        .map(|s| (s.sig_own / s.white, s.pfree))
        .collect();
    if v.is_empty() {
        return f64::NAN;
    }
    let rho = wmedian(&mut v);
    for s in s1.iter_mut() {
        if s.sig_own.is_finite() && s.sig_own > 0.0 && s.white.is_finite() && s.white > 0.0 {
            s.sig = s.white * rho * s.wscale;
        }
    }
    rho
}

/// Weighted median of (value, weight) pairs: the first value at which the running weight reaches half the total.
fn wmedian(v: &mut [(f64, f64)]) -> f64 {
    v.sort_by(|a, b| a.0.total_cmp(&b.0));
    let tot: f64 = v.iter().map(|p| p.1).sum();
    let mut c = 0.0;
    let mut rho = v[v.len() - 1].0;
    for p in v.iter() {
        c += p.1;
        if c >= 0.5 * tot {
            rho = p.0;
            break;
        }
    }
    rho
}

/// One cell's fit for every shared combination: (ll, unit, rho) per combo.
#[derive(Clone, Debug, Default)]
pub struct Stage2 {
    pub ll: Vec<f64>,
    pub u: Vec<f64>,
    pub rho: Vec<f64>,
}

/// Recording-level null fallback: cells without ne take the median of the others (nanmedian), else the white-noise value.
pub fn fill_ne(ne: &mut [f64], ne_white: f64) {
    let fin: Vec<f64> = ne.iter().cloned().filter(|v| v.is_finite()).collect();
    let fb = if fin.is_empty() {
        ne_white
    } else {
        median(&fin)
    };
    ne.iter_mut().for_each(|v| {
        if !v.is_finite() {
            *v = fb
        }
    });
}

/// Shared choice: the combination maximising the summed log-likelihood over the
/// cells whose 30 values are all finite. A cell without them takes its
/// `fallback`. Returns (combo index, per-cell unit, per-cell degenerate flag).
pub fn combine(fallback: &[f64], s2: &[Option<Stage2>]) -> (usize, Vec<f64>, Vec<bool>) {
    let ok: Vec<bool> = s2
        .iter()
        .map(|o| {
            o.as_ref()
                .is_some_and(|r| r.ll.iter().all(|v| v.is_finite()))
        })
        .collect();
    let mut tot = vec![0.0; NCOMBO];
    for (c, o) in s2.iter().enumerate() {
        if ok[c] {
            for i in 0..NCOMBO {
                tot[i] += o.as_ref().unwrap().ll[i];
            }
        }
    }
    let ib = if ok.iter().any(|&b| b) {
        argmax_first(&tot)
    } else {
        0
    };
    let u = (0..fallback.len())
        .map(|c| {
            if ok[c] {
                s2[c].as_ref().unwrap().u[ib]
            } else {
                fallback[c]
            }
        })
        .collect();
    (ib, u, ok.iter().map(|b| !b).collect())
}

/// Per-cell result of the unit step on one recording.
pub struct Units {
    /// Index of the recording's shared combination (q, gamma, s).
    pub shared: usize,
    /// Unit per cell: always finite and positive.
    pub u: Vec<f64>,
    /// Count-law parameter per cell (NaN for a cell that did not vote).
    pub rho: Vec<f64>,
    /// Noise sd of the unit filter's output over the unit, per cell (NaN without a noise reading): where the
    /// counting step's noise scale starts.
    pub s0: Vec<f64>,
}

/// The whole estimator on one recording: every cell's noise reading, pooled, then the unit from the nested isolated
/// extrema ([`ov_recording`]).
pub fn recording(traces: &[Vec<f64>], st: &Setup) -> Units {
    let mut s1: Vec<Stage1> = traces.iter().map(|y| stage1_cell(y, st)).collect();
    pool_noise(&mut s1);
    let sig: Vec<f64> = s1.iter().map(|s| s.sig).collect();
    let mut r = ov_recording(traces, st, &sig);
    r.s0 = sig.iter().zip(&r.u).map(|(s, u)| s / u).collect();
    r
}

// ---------- the unit from nested isolated extrema ----------

/// Inverse of the standard normal cdf.
/// Newton on this module's `ndtr` from the Abramowitz-Stegun 26.2.23 start (a few iterations to full precision).
pub fn ndtri(p: f64) -> f64 {
    if !(p > 0.0 && p < 1.0) {
        return if p == 0.0 {
            f64::NEG_INFINITY
        } else if p == 1.0 {
            f64::INFINITY
        } else {
            f64::NAN
        };
    }
    let q = p.min(1.0 - p); // lower-tail probability of -x, x >= 0
    let t = (-2.0 * q.ln()).sqrt();
    let mut x = (t
        - (2.515517 + 0.802853 * t + 0.010328 * t * t)
            / (1.0 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t))
        .max(0.0);
    for _ in 0..50 {
        let dx = (ndtr(-x) - q) / ((-0.5 * x * x).exp() / (2.0 * std::f64::consts::PI).sqrt());
        x += dx;
        if dx.abs() <= 1e-15 * x.abs().max(1.0) {
            break;
        }
    }
    if p < 0.5 {
        -x
    } else {
        x
    }
}

type Window = Option<Rc<(Vec<f64>, f64)>>;

/// Window fits a_{g,h}: the onset filter on [t - g, t + h) and its norm, cached. The kernel's equivalent width W is
/// real-valued and n = ceil(W), so every window with a reach-long side is interpolated with its partner one frame
/// shorter on that side: w = (1 - f) w_{g,h} + f w_{min(g, n-1), min(h, n-1)}, f = n - W; both terms are unbiased
/// for an event at t, so the combination is. (n, n) is the unit filter.
pub struct Win {
    k: Vec<f64>,
    ab: (f64, f64),
    pub n: usize,
    f: f64,
    c: std::collections::HashMap<(usize, usize, bool), Window>,
}

impl Win {
    pub fn new(k: &[f64], a: f64, b: f64) -> Win {
        let (s, s2): (f64, f64) = (k.iter().sum(), k.iter().map(|v| v * v).sum());
        let n = neq(k);
        Win {
            k: k.to_vec(),
            ab: (a, b),
            n,
            f: n as f64 - s * s / s2,
            c: Default::default(),
        }
    }
    /// The window on the integer grid (None when it cannot carry the four-term fit).
    fn raw(&mut self, g: usize, h: usize) -> Window {
        if let Some(r) = self.c.get(&(g, h, false)) {
            return r.clone();
        }
        let r = (g >= 1 && h >= 2 && g + h >= 5)
            .then(|| {
                let w = window_filter(&self.k, self.ab.0, self.ab.1, g, h);
                let nw = dot(&w, &w).sqrt();
                nw.is_finite().then(|| Rc::new((w, nw)))
            })
            .flatten();
        self.c.insert((g, h, false), r.clone());
        r
    }
    pub fn get(&mut self, g: usize, h: usize) -> Window {
        let n = self.n;
        if g != n && h != n {
            return self.raw(g, h);
        }
        let f = self.f;
        if let Some(r) = self.c.get(&(g, h, true)) {
            return r.clone();
        }
        let (g2, h2) = (g.min(n - 1), h.min(n - 1));
        let r = self.raw(g, h).map(|w1| match self.raw(g2, h2) {
            None => w1, // no shorter window exists: the integer window stands
            Some(w2) => {
                let mut w: Vec<f64> = w1.0.iter().map(|v| (1.0 - f) * v).collect();
                w[g - g2..g - g2 + g2 + h2]
                    .iter_mut()
                    .zip(&w2.0)
                    .for_each(|(x, y)| *x += f * y);
                let nw = dot(&w, &w).sqrt();
                Rc::new((w, nw))
            }
        });
        self.c.insert((g, h, true), r.clone());
        r
    }
}

/// One nested isolated extremum: frame, amplitude, sd factor (norm of its window), window sides.
#[derive(Clone, Copy, Debug)]
struct Pick {
    t: usize,
    a: f64,
    s: f64,
    g: usize,
    h: usize,
}

/// Nested isolated extrema: the frame with the largest |amplitude| / sd of a segment is picked (full window where both sides
/// reach n, cut windows near the segment's ends), then the two segments either side of it, down to segments too short for a
/// reach-long clean side. `a0` = the full-window field, `s0` its sd factor.
fn picks(y: &[f64], win: &mut Win, a0: &[f64], s0: f64) -> Vec<Pick> {
    let n = win.n;
    let mut out = Vec::new();
    let mut stack = vec![(0usize, y.len())];
    while let Some((l, r)) = stack.pop() {
        if r - l < 5.max(n + 1) {
            continue;
        }
        let mut best: Option<Pick> = None;
        let mut bz = -1.0;
        let i0 = l + n;
        let i1 = r - n;
        let (e1, e2) = if i1 >= i0 {
            for i in i0..=i1 {
                let z = if a0[i].is_finite() { a0[i].abs() } else { -1.0 } / s0;
                if i == i0 || z > bz {
                    bz = z;
                    best = Some(Pick {
                        t: i,
                        a: a0[i],
                        s: s0,
                        g: n,
                        h: n,
                    });
                }
            }
            (l + 1..i0, i1 + 1..r - 1)
        } else {
            (l + 1..r - 1, 0..0)
        };
        for (t, g, h) in e1
            .map(|t| (t, t - l, (r - t).min(n)))
            .chain(e2.map(|t| (t, n, r - t)))
        {
            let Some(w) = win.get(g, h) else { continue };
            let a = dot(&w.0, &y[t - g..t + h]);
            let z = a.abs() / w.1;
            if z > bz {
                bz = z;
                best = Some(Pick { t, a, s: w.1, g, h });
            }
        }
        let Some(p) = best else { continue };
        out.push(p);
        stack.push((l, p.t));
        stack.push((p.t, r));
    }
    out
}

/// Null parameter of the one-sided windows: the f-weighted median of (2 Phi(z) - 1)^(1 + (ne - 1) f) over the negative picks = 1/2.
fn ne_fit(zneg: &[f64], f: &[f64]) -> f64 {
    if zneg.len() < 5 {
        return f64::NAN;
    }
    let big: Vec<f64> = zneg
        .iter()
        .map(|&z| (2.0 * ndtr(z) - 1.0).clamp(1e-300, 1.0 - 1e-16))
        .collect();
    let med = |ne: f64| {
        let mut v: Vec<(f64, f64)> = big
            .iter()
            .zip(f)
            .map(|(b, &fi)| (b.powf(1.0 + (ne - 1.0) * fi), fi))
            .collect();
        wmedian(&mut v)
    };
    let (mut lo, mut hi) = (1e-3_f64.ln(), 1e6_f64.ln());
    if med(lo.exp()) < 0.5 || med(hi.exp()) > 0.5 {
        return f64::NAN;
    }
    for _ in 0..60 {
        let mid = 0.5 * (lo + hi);
        if med(mid.exp()) > 0.5 {
            lo = mid
        } else {
            hi = mid
        }
    }
    (0.5 * (lo + hi)).exp()
}

/// The ne of the extreme law (2 Phi(x / scale) - 1)^ne from the ratio of the lower quartile to the median of x.
fn qfit_ne(x: &[f64]) -> f64 {
    let (x1, x2) = (quantile(x, 0.25), quantile(x, 0.5));
    let q = |p: f64, ne: f64| ndtri((1.0 + p.powf(1.0 / ne)) / 2.0);
    let (mut lo, mut hi) = (0.05_f64.ln(), 1e4_f64.ln());
    for _ in 0..50 {
        let mid = 0.5 * (lo + hi);
        if q(0.25, mid.exp()) / q(0.5, mid.exp()) < x1 / x2 {
            lo = mid
        } else {
            hi = mid
        }
    }
    (0.5 * (lo + hi)).exp()
}

/// The picks of one cell that enter the likelihood (a reach-long clean stretch on at least one side).
#[derive(Default)]
struct OvCell {
    a: Vec<f64>,
    /// sd factor relative to the full window (1 for a full window).
    s: Vec<f64>,
    full: Vec<bool>,
    /// (g + h) / 2n.
    f: Vec<f64>,
    /// The window (g, h): picks of one window share its sd, null law and selection term.
    gh: Vec<(usize, usize)>,
}

/// Log-likelihood of one cell's picks for every unit of the scan, maximised over the count-law parameter: the positive
/// picks are noise or events, per window type (full, one-sided) with its own null share; the full windows use the
/// exact selection term ([`Signed::dn`]), the one-sided ones a normal approximation of the null extreme.
/// Returns (unit scan, ll, rho).
fn profile_ov(
    c: &OvCell,
    sig: f64,
    ne: [f64; 2],
    lev: (f64, f64, f64),
) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let cls = |i: usize| usize::from(!c.full[i]);
    let mut nneg = [0.0_f64; 2];
    let mut npos = [0.0_f64; 2];
    (0..c.a.len()).for_each(|i| {
        if c.a[i] > 0.0 {
            npos[cls(i)] += 1.0
        } else {
            nneg[cls(i)] += 1.0
        }
    });
    let ix: Vec<usize> = (0..c.a.len()).filter(|&i| c.a[i] > 0.0).collect();
    let n = ix.len();
    let z: Vec<f64> = ix.iter().map(|&i| c.a[i] / (sig * c.s[i])).collect();
    let amax = |only_full: bool| {
        ix.iter()
            .filter(|&&i| c.full[i] || !only_full)
            .map(|&i| c.a[i])
            .fold(f64::NEG_INFINITY, f64::max)
    };
    let zt = ((if npos[0] > 0.0 {
        amax(true)
    } else {
        amax(false)
    }) / sig)
        .max(2.0);
    let (ug, nn, lo, hi, lv, cvv) = scan(zt, lev);
    let (nu, nk) = (ug.len(), nn.len());
    let sg = Signed::new(ne[0]);
    // the distinct one-sided windows among the picks, and each pick's index into them
    let mut wins: Vec<(usize, usize)> = ix
        .iter()
        .filter(|&&i| !c.full[i])
        .map(|&i| c.gh[i])
        .collect();
    wins.sort();
    wins.dedup();
    let wi: Vec<usize> = ix
        .iter()
        .map(|&i| wins.binary_search(&c.gh[i]).unwrap_or(0))
        .collect();
    let mut dw = vec![0.0; wins.len()];
    // per pick: null cdf and density at the data, and the normal approximation (median, half the 16-84% spread) of the null extreme
    let (mut g0, mut f0, mut mm, mut tau, mut sw_) = (
        vec![0.0; n],
        vec![0.0; n],
        vec![0.0; wins.len()],
        vec![0.0; wins.len()],
        vec![0.0; wins.len()],
    );
    for (j, &i) in ix.iter().enumerate() {
        let nej = if c.full[i] {
            ne[0]
        } else {
            1.0 + (ne[1] - 1.0) * c.f[i]
        };
        let big = (2.0 * ndtr(z[j]) - 1.0).clamp(1e-300, 1.0);
        g0[j] = if c.full[i] {
            sg.g0(z[j])
        } else {
            big.powf(nej)
        };
        f0[j] = (nej * big.powf(nej - 1.0) * 2.0 * (-0.5 * z[j] * z[j]).exp() / SQ2PI).max(1e-300);
        if !c.full[i] {
            let q = |p: f64| ndtri(((1.0 + p.powf(1.0 / nej)) / 2.0).clamp(1e-16, 1.0 - 1e-16));
            mm[wi[j]] = q(0.5);
            tau[wi[j]] = 0.5 * (q(0.8413) - q(0.1587));
            sw_[wi[j]] = c.s[i];
        }
    }
    let mut comp = vec![0.0; nu * nk * n];
    for u in 0..nu {
        for k in 0..nk {
            let a = ug[u] * lv[k];
            let extra = if nn[k] > 12.0 { 0.25 * 0.29 } else { 0.0 };
            let cva2 = (cvv[k] * a).powi(2) + (extra * a).powi(2);
            let cva = cva2.sqrt();
            let sdev = (1.0 + cva * cva).sqrt();
            let dn = if npos[0] > 0.0 { sg.dn(a, sdev) } else { 1.0 };
            for (t, d) in dw.iter_mut().enumerate() {
                *d = ndtr(
                    (a / sw_[t] - mm[t])
                        / (tau[t] * tau[t] + 1.0 + cva2 / (sw_[t] * sw_[t])).sqrt(),
                )
                .max(1e-12);
            }
            let base = (u * nk + k) * n;
            for (j, &i) in ix.iter().enumerate() {
                comp[base + j] = if c.full[i] {
                    let e = (z[j] - a) / sdev;
                    (-0.5 * e * e).exp() / (SQ2PI * sdev) * g0[j] / dn
                } else {
                    let s = c.s[i];
                    let (mu, var) = (a / s, 1.0 + cva2 / (s * s));
                    (-0.5 * (z[j] - mu).powi(2) / var).exp() / (TWO_PI * var).sqrt() * g0[j]
                        / dw[wi[j]]
                };
            }
        }
    }
    let lf0: f64 = f0.iter().map(|v| v.ln()).sum();
    let mut best = vec![f64::NEG_INFINITY; nu];
    let mut br = vec![0.0; nu];
    let (mut q, mut wn) = (vec![0.0; n], vec![0.0; nk]);
    for &rho in &rho_grid() {
        for u in 0..nu {
            let mut sw = 0.0;
            for k in 0..nk {
                wn[k] = rho.powf(lo[k] - 1.0) - rho.powf(hi[k] - 1.0);
                sw += wn[k];
            }
            q.iter_mut().for_each(|v| *v = 0.0);
            for k in 0..nk {
                let wk = wn[k] / sw;
                let base = (u * nk + k) * n;
                for j in 0..n {
                    q[j] += wk * comp[base + j];
                }
            }
            for j in 0..n {
                q[j] = (q[j] + 1e-300) / f0[j];
            }
            // EM for the null share of each window type
            let mut p = [0.5_f64; 2];
            for _ in 0..25 {
                let mut rs = [0.0_f64; 2];
                for (j, &i) in ix.iter().enumerate() {
                    let pc = p[cls(i)];
                    rs[cls(i)] += 1.0 / (1.0 + 2.0 * (1.0 - pc) / pc * q[j]);
                }
                for t in 0..2 {
                    if npos[t] > 0.0 {
                        p[t] = ((nneg[t] + rs[t]) / (nneg[t] + npos[t])).clamp(1e-4, 1.0 - 1e-4);
                    }
                }
            }
            let mut ll = lf0;
            for t in 0..2 {
                if npos[t] > 0.0 || nneg[t] > 0.0 {
                    ll += nneg[t] * (0.5 * p[t]).ln();
                }
            }
            for (j, &i) in ix.iter().enumerate() {
                let pc = p[cls(i)];
                ll += (0.5 * pc + (1.0 - pc) * q[j]).ln();
            }
            if ll > best[u] {
                best[u] = ll;
                br[u] = rho;
            }
        }
    }
    (ug.iter().map(|v| v * sig).collect(), best, br)
}

/// The unit of every cell of one recording: raw traces, the kernel's setup and the pooled noise reading `sig` per cell
/// (on the unit filter's scale) -> per cell a finite positive unit. The noise sd is the smaller of `sig` and the
/// reading from the negative full-window picks (shared shape, weighted as `pool_noise`); events can only raise
/// either one.
pub fn ov_recording(traces: &[Vec<f64>], st: &Setup, sig: &[f64]) -> Units {
    let n = st.r2;
    let wu = &st.wu;
    let s0 = dot(wu, wu).sqrt();
    let mut win = Win::new(&st.k, st.ab.0, st.ab.1);
    let nc = traces.len();
    let mut cells: Vec<OvCell> = Vec::with_capacity(nc);
    // second noise reading: per cell the median negative full-window pick, in units of white level x filter norm, weighted by the event-free share
    let (mut med, mut white, mut pfree) = (vec![f64::NAN; nc], vec![0.0; nc], vec![0.0; nc]);
    let mut pool: Vec<f64> = Vec::new();
    for (c, y) in traces.iter().enumerate() {
        let a0 = apply(wu, n, y);
        let mut oc = OvCell::default();
        for p in picks(y, &mut win, &a0, s0)
            .iter()
            .filter(|p| p.g == n || p.h == n)
        {
            oc.a.push(p.a);
            oc.s.push(p.s / s0);
            oc.full.push(p.g == n && p.h == n);
            oc.f.push((p.g + p.h) as f64 / (2.0 * n as f64));
            oc.gh.push((p.g, p.h));
        }
        let x: Vec<f64> = (0..oc.a.len())
            .filter(|&i| oc.full[i] && oc.a[i] < 0.0)
            .map(|i| -oc.a[i])
            .collect();
        if x.len() >= 5 {
            med[c] = median(&x);
            if med[c] > 0.0 {
                pool.extend(x.iter().map(|v| v / med[c]));
            }
        }
        let (npos, nneg, _) = sign_counts(&a0, n);
        let kap = ((npos - nneg) * (2 * n + 1) as f64
            / (y.len() as f64 - 2.0 * n as f64 + 1.0).max(1.0))
        .max(0.0)
        .min(1.0 - 1.0 / (npos + 1.0));
        white[c] = white_sd(y) * s0;
        pfree[c] = 1.0 - kap;
        cells.push(oc);
    }
    let ne_pool = if pool.len() >= 20 {
        qfit_ne(&pool)
    } else {
        st.tab.ne_white
    };
    let qn = ndtri((1.0 + 0.5_f64.powf(1.0 / ne_pool)) / 2.0);
    let mut tv: Vec<(f64, f64)> = (0..nc)
        .filter(|&c| white[c] > 0.0 && (med[c] / qn / white[c]).is_finite())
        .map(|c| (med[c] / qn / white[c], pfree[c]))
        .collect();
    let sig: Vec<f64> = if tv.is_empty() {
        sig.to_vec()
    } else {
        let shape = wmedian(&mut tv);
        (0..nc)
            .map(|c| {
                let (s1, s2) = (
                    sig[c],
                    if white[c] > 0.0 {
                        white[c] * shape
                    } else {
                        f64::NAN
                    },
                );
                if s1.is_finite() && s2.is_finite() {
                    s1.min(s2)
                } else if s1.is_finite() {
                    s1
                } else {
                    s2
                }
            })
            .collect()
    };
    // null parameters per window type, each from its own negative picks; under 5 of a type: the recording's median, else the white value
    let okc = |c: usize| sig[c].is_finite() && sig[c] > 0.0;
    let mut ne = [vec![f64::NAN; nc], vec![f64::NAN; nc]];
    for (c, oc) in cells.iter().enumerate().filter(|(c, _)| okc(*c)) {
        let neg =
            |full: bool| (0..oc.a.len()).filter(move |&i| oc.a[i] < 0.0 && oc.full[i] == full);
        let x: Vec<f64> = neg(true).map(|i| -oc.a[i]).collect();
        ne[0][c] = ne_of(if x.len() >= 5 { median(&x) } else { f64::NAN }, sig[c]);
        let z: Vec<f64> = neg(false).map(|i| -oc.a[i] / (sig[c] * oc.s[i])).collect();
        let f: Vec<f64> = neg(false).map(|i| oc.f[i]).collect();
        ne[1][c] = ne_fit(&z, &f);
    }
    ne.iter_mut().for_each(|v| fill_ne(v, st.tab.ne_white));
    let s2: Vec<Option<Stage2>> = (0..nc)
        .map(|c| {
            (okc(c) && cells[c].a.iter().filter(|&&v| v > 0.0).count() >= 3).then(|| {
                let mut out = Stage2::default();
                for cb in combos() {
                    let (u, ll, br) = profile_ov(&cells[c], sig[c], [ne[0][c], ne[1][c]], cb);
                    let (uh, j) = pick(&u, &ll);
                    out.ll.push(ll[j]);
                    out.u.push(uh);
                    out.rho.push(br[j]);
                }
                out
            })
        })
        .collect();
    // the shared choice and the degenerate fallback (the cell's largest |pick|) through `combine`
    let fb: Vec<f64> = cells
        .iter()
        .map(|oc| {
            let mx =
                oc.a.iter()
                    .filter(|v| v.is_finite())
                    .map(|v| v.abs())
                    .fold(0.0, f64::max);
            if mx > 0.0 {
                mx
            } else {
                1.0
            }
        })
        .collect();
    let (shared, u, deg) = combine(&fb, &s2);
    let rho = (0..nc)
        .map(|c| {
            if deg[c] {
                f64::NAN
            } else {
                s2[c].as_ref().unwrap().rho[shared]
            }
        })
        .collect();
    Units {
        shared,
        u,
        rho,
        s0: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_cdf_is_accurate() {
        // reference values (scipy.special.ndtr)
        for (z, v) in [
            (0.0, 0.5),
            (1.0, 0.8413447460685429),
            (-2.0, 0.022750131948179195),
            (3.5, 0.9997673709209645),
            (-6.0, 9.865876450376946e-10),
        ] {
            assert!(
                (ndtr(z) - v).abs() < 1e-14 * v.max(1e-3),
                "{z}: {} vs {v}",
                ndtr(z)
            );
        }
    }

    #[test]
    fn filter_is_unbiased_at_the_onset() {
        let (k, a, b) = kern_blind(0.04, 0.3, 30.0);
        let (w, m) = onset_filter(&k, a, b);
        let r = response(&w, m, &k, 3);
        assert!((r[3] - 1.0).abs() < 1e-9, "{r:?}");
        let mut y: Vec<f64> = (0..400).map(|i| 3.0 + 2.0 * 0.9_f64.powi(i)).collect();
        for (i, &kv) in k.iter().enumerate() {
            if 200 + i < 400 {
                y[200 + i] += 4.0 * kv;
            }
        }
        let o = apply(&w, m, &y);
        assert!((o[200] - 4.0).abs() < 1e-6, "{}", o[200]);
    }

    #[test]
    fn pool_noise_reads_the_least_crowded_cells() {
        // readings sig_own / white = 1.0, 1.1 (free windows) and 5, 6 (crowded): the weighted median ignores the crowded pair
        let mk = |own: f64, white: f64, pfree: f64| Stage1 {
            sig: own,
            white,
            pfree,
            sig_own: own,
            wscale: 1.0,
        };
        let mut s1 = vec![
            mk(2.0, 2.0, 1.0),
            mk(1.1, 1.0, 0.9),
            mk(15.0, 3.0, 0.1),
            mk(6.0, 1.0, 0.05),
            mk(f64::NAN, 1.0, 1.0),
        ];
        let rho = pool_noise(&mut s1);
        assert_eq!(rho, 1.1); // weights 1, 0.9, 0.1, 0.05: half the total (1.025) is first reached at 1.1
        assert!((s1[2].sig - 3.3).abs() < 1e-12);
        assert!(
            s1[4].sig.is_nan(),
            "a cell without its own reading is left as it was"
        );
    }

    #[test]
    fn every_cell_gets_a_number() {
        let tr = vec![vec![0.0; 500], vec![3.0; 500], normals(2000, 9)];
        let st = Setup::new(0.04, 0.3, 30.0);
        let u = recording(&tr, &st).u;
        assert!(u.iter().all(|v| v.is_finite() && *v > 0.0), "{u:?}");
    }

    #[test]
    fn null_table_is_the_same_on_every_run() {
        // the white-noise sample has a fixed seed: two builds of the table agree to the bit, and the value is pinned
        // (to 1e-9, which leaves room for a last-digit difference in a platform's ln / sin / cos)
        let (a, b) = (Setup::new(0.04, 0.3, 30.0), Setup::new(0.04, 0.3, 30.0));
        assert_eq!(a.tab.ne_white.to_bits(), b.tab.ne_white.to_bits());
        assert_eq!(a.tab.q0.map(f64::to_bits), b.tab.q0.map(f64::to_bits));
        assert!(
            (a.tab.ne_white / 17.60847454672611 - 1.0).abs() < 1e-9,
            "{:?}",
            a.tab.ne_white
        );
    }

    #[test]
    fn ndtri_inverts_the_normal_cdf() {
        // reference values (scipy.special.ndtri)
        for (p, x) in [
            (0.975, 1.959963984540054),
            (1e-6, -4.753424308822899),
            (0.5, 0.0),
            (0.8413, 0.9998150936147446),
        ] {
            assert!((ndtri(p) - x).abs() < 1e-12, "{p}: {} vs {x}", ndtri(p));
        }
        assert!((ndtr(ndtri(1e-16)) / 1e-16 - 1.0).abs() < 1e-9);
    }

    #[test]
    fn w_filter_is_the_interpolation_of_the_two_integer_windows() {
        let (k, a, b) = kern_blind(0.0333, 0.105, 30.0);
        let n = neq(&k);
        let mut w1 = Win::new(&k, a, b);
        let f = w1.f;
        assert!((0.0..1.0).contains(&f), "{f}");
        // (n, n), the unit filter: (1 - f) w_n + f w_{n-1}, the shorter one centred
        let (wn, wm, ww) = (
            w1.raw(n, n).unwrap(),
            w1.raw(n - 1, n - 1).unwrap(),
            w1.get(n, n).unwrap(),
        );
        for i in 0..2 * n {
            let e = (1.0 - f) * wn.0[i]
                + if i >= 1 && i < 2 * n - 1 {
                    f * wm.0[i - 1]
                } else {
                    0.0
                };
            assert!((ww.0[i] - e).abs() < 1e-12);
        }
        assert_eq!(Setup::new(0.0333, 0.105, 30.0).wu, ww.0);
        assert_eq!(
            wn.0,
            onset_filter(&k, a, b).0,
            "the integer window is the onset filter"
        );
        // every window with a reach-long side: unbiased for an event at t, blind to a constant, sd between its two nested windows
        for (g, h) in [(n, n), (6, n), (n, 5), (1, n), (n, 2)] {
            let w = w1.get(g, h).unwrap();
            let tm: Vec<f64> = (0..g + h)
                .map(|i| if i >= g { k[i - g] } else { 0.0 })
                .collect();
            assert!(
                (dot(&w.0, &tm) - 1.0).abs() < 1e-6 && w.0.iter().sum::<f64>().abs() < 1e-6,
                "{g} {h}"
            );
            let (lo, hi) = (
                w1.raw(g.min(n - 1), h.min(n - 1)).unwrap().1,
                w1.raw(g, h).unwrap().1,
            );
            assert!(
                hi - 1e-9 <= w.1 && w.1 <= lo + 1e-9,
                "{g} {h}: {hi} {} {lo}",
                w.1
            );
        }
        // windows cut on both sides are not interpolated
        assert_eq!(w1.get(4, 5).unwrap().0, w1.raw(4, 5).unwrap().0);
    }

    #[test]
    fn cut_windows_read_a_shadowed_event_exactly() {
        let (k, a, b) = kern_blind(0.04, 0.3, 30.0);
        let n = neq(&k);
        let mut win = Win::new(&k, a, b);
        let ev = |spec: &[(usize, f64)]| {
            let mut y = vec![3.0; 400];
            for &(t, amp) in spec {
                k.iter()
                    .enumerate()
                    .filter(|(i, _)| t + i < 400)
                    .for_each(|(i, kv)| y[t + i] += amp * kv);
            }
            y
        };
        // a window cut 6 frames before the event does not see a two-frame burst that ended 7 frames earlier
        let y = ev(&[(150, 20.0), (151, 15.0), (158, 4.0)]);
        let w = win.get(6, n).unwrap();
        assert!((dot(&w.0, &y[152..158 + n]) - 4.0).abs() < 1e-6);
        // a window cut 5 frames after the event does not see the next one
        let yy = ev(&[(150, 4.0), (156, 30.0)]);
        let w = win.get(n, 5).unwrap();
        assert!((dot(&w.0, &yy[150 - n..155]) - 4.0).abs() < 1e-6);
        // the nested picks find the shadowed event with its exact size, through a cut window
        let w = win.get(n, n).unwrap();
        let pk = picks(&y, &mut win, &apply(&w.0, n, &y), w.1);
        let p = pk
            .iter()
            .find(|p| p.t == 158)
            .expect("the shadowed event is picked");
        assert!((p.a - 4.0).abs() < 1e-6 && p.g < n, "{p:?}");
        // windows too short for the four-term fit do not exist
        assert!(win.get(0, n).is_none() && win.get(4, 1).is_none() && win.get(2, 2).is_none());
    }
}
