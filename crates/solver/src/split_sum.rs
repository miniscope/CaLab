// `x.max(lo).min(hi)` is kept on purpose where a parameter is boxed: it maps a NaN to a bound, where `clamp` would
// propagate it into the fit.
#![allow(clippy::manual_clamp)]
#![allow(
    dead_code,
    clippy::too_many_arguments,
    clippy::type_complexity,
    clippy::needless_range_loop
)]
//! Split-sum partition marginal with empirical-Bayes EM. Rust port of splitsum.py (the verified reference);
//! every function mirrors its Python counterpart and is checked against it by parity tests.
//!
//! Pieces i = 0..n-1 in time order (mass m, centre c, start st, end en). A partition cuts them into contiguous
//! segments; score = prod over segments of
//!   lattice(M, W) = exp(-lam W) HalfNormal(M; sn) + (1-exp(-lam W)) sum_{j>=1} (1-rho) rho^(j-1) N(M; j u, sx^2 + j s1^2)
//!   x split (a+1)!/M^a (Dirichlet(1..1), largest = parent)   [old spec: (2/M)^a]
//!   x placement a! prod p_join(d_k)                            [positions]
//!   x boundary prior pi^a (1-pi)
//!   x cut gap p_gap(g), g = st_first - st_prev, all segments but the first   [positions]

pub(crate) const TAIL: f64 = 80.0;
pub(crate) const EPS: f64 = 1e-3;
/// Log terms this far below the largest are dropped from a sum (relative size e^-40 = 4e-18, under f64 rounding).
const SKIP: f64 = 40.0;
const LN_2PI: f64 = 1.8378770664093453; // ln(2 pi)

#[inline]
fn logaddexp(a: f64, b: f64) -> f64 {
    if a == f64::NEG_INFINITY {
        return b;
    }
    if b == f64::NEG_INFINITY {
        return a;
    }
    let m = a.max(b);
    m + ((a - m).exp() + (b - m).exp()).ln()
}

fn logsumexp(v: &[f64]) -> f64 {
    let m = v.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    if !m.is_finite() {
        return m;
    }
    // Terms more than SKIP below the largest are left out: each is under e^-SKIP (4e-18) of the sum.
    let cut = m - SKIP;
    let mut acc = 0.0;
    for &x in v {
        if x > cut {
            acc += (x - m).exp();
        }
    }
    m + acc.ln()
}

// ------------------------------------------------------------------ lattice (exact)
pub(crate) fn jrange(mmax: f64, u: f64, sx: f64, s1: f64, rho: f64) -> usize {
    let sd = (sx * sx + (mmax / u).max(1.0) * s1 * s1).sqrt();
    let dec = -(rho.max(1e-300)).ln() + u * u / (2.0 * (s1 * s1).max(1e-300));
    let hi = (mmax / u).floor() + (12.0 * sd / u).ceil() + (TAIL / dec.max(1e-4)).ceil() + 3.0;
    (hi as i64).min(40000).max(1) as usize
}

#[derive(Clone, Copy)]
pub(crate) struct Lat {
    pub sx: f64,
    pub sn: f64,
    pub lam: f64,
    pub u: f64,
    pub s1: f64,
    pub rho: f64,
    pub sw: f64,
    pub eta: f64,
}

#[inline]
pub(crate) fn log_hn(m: f64, s: f64) -> f64 {
    -0.5 * (std::f64::consts::PI / 2.0 * s * s).ln() - 0.5 * m * m / (s * s)
}

thread_local! { static JTAB: std::cell::RefCell<([u64; 3], Vec<f64>, Vec<f64>)> = const { std::cell::RefCell::new(([0; 3], Vec::new(), Vec::new())) }; }

impl Lat {
    /// Null log term l0 and log j-terms for j = 1..=J into `buf`; returns l0.
    fn parts(&self, m: f64, w: f64, j_max: usize, buf: &mut Vec<f64>) -> f64 {
        let lp0 = -self.lam * w;
        let ln0 = if self.eta <= 0.0 {
            log_hn(m, self.sn)
        } else {
            logaddexp(
                (-self.eta).ln_1p() + log_hn(m, self.sn),
                self.eta.ln() + log_hn(m, self.sw),
            )
        };
        let l0 = lp0 + ln0;
        let lr = (-(lp0.exp_m1())).max(1e-300).ln();
        // The j-terms' constants depend only on (sx, s1, rho): cached per thread, rebuilt when they change.
        JTAB.with(|t| {
            let mut t = t.borrow_mut();
            let key = [self.sx.to_bits(), self.s1.to_bits(), self.rho.to_bits()];
            if t.0 != key {
                t.0 = key;
                t.1.clear();
                t.2.clear();
            }
            let lrho = self.rho.max(1e-300).ln();
            let l1r = (-self.rho).ln_1p();
            while t.1.len() < j_max {
                let j = (t.1.len() + 1) as f64;
                let var = self.sx * self.sx + j * self.s1 * self.s1;
                t.1.push(l1r + (j - 1.0) * lrho - 0.5 * (LN_2PI + var.ln()));
                t.2.push(0.5 / var);
            }
            buf.clear();
            for jj in 0..j_max {
                let d = m - (jj + 1) as f64 * self.u;
                buf.push(lr + t.1[jj] - d * d * t.2[jj]);
            }
        });
        l0
    }
    pub fn logp(&self, m: f64, w: f64, buf: &mut Vec<f64>) -> f64 {
        let j_max = jrange(m, self.u, self.sx, self.s1, self.rho);
        let l0 = self.parts(m, w, j_max, buf);
        logaddexp(l0, logsumexp(buf))
    }
}

/// A [`Lat`] with the terms that are the same for every segment worked out once. Every value is computed by the same
/// expression as in [`Lat::parts`] / [`jrange`], so results are bit-identical.
pub(crate) struct LatK {
    l: Lat,
    hn_c: f64,
    hn_s2: f64,
    tail_j: f64,
}

impl LatK {
    pub fn new(l: Lat) -> Self {
        let dec = -(l.rho.max(1e-300)).ln() + l.u * l.u / (2.0 * (l.s1 * l.s1).max(1e-300));
        LatK {
            l,
            hn_c: -0.5 * (std::f64::consts::PI / 2.0 * l.sn * l.sn).ln(),
            hn_s2: l.sn * l.sn,
            tail_j: (TAIL / dec.max(1e-4)).ceil(),
        }
    }
    #[inline]
    pub fn jmax(&self, m: f64) -> usize {
        let l = &self.l;
        let sd = (l.sx * l.sx + (m / l.u).max(1.0) * l.s1 * l.s1).sqrt();
        let hi = (m / l.u).floor() + (12.0 * sd / l.u).ceil() + self.tail_j + 3.0;
        (hi as i64).min(40000).max(1) as usize
    }
    /// As [`Lat::parts`].
    pub fn parts(&self, m: f64, w: f64, j_max: usize, buf: &mut Vec<f64>) -> f64 {
        let l = &self.l;
        let lp0 = -l.lam * w;
        let ln0 = if l.eta <= 0.0 {
            self.hn_c - 0.5 * m * m / self.hn_s2
        } else {
            logaddexp(
                (-l.eta).ln_1p() + log_hn(m, l.sn),
                l.eta.ln() + log_hn(m, l.sw),
            )
        };
        let l0 = lp0 + ln0;
        let lr = (-(lp0.exp_m1())).max(1e-300).ln();
        JTAB.with(|t| {
            let mut t = t.borrow_mut();
            let key = [l.sx.to_bits(), l.s1.to_bits(), l.rho.to_bits()];
            if t.0 != key {
                t.0 = key;
                t.1.clear();
                t.2.clear();
            }
            if t.1.len() < j_max {
                let lrho = l.rho.max(1e-300).ln();
                let l1r = (-l.rho).ln_1p();
                while t.1.len() < j_max {
                    let j = (t.1.len() + 1) as f64;
                    let var = l.sx * l.sx + j * l.s1 * l.s1;
                    t.1.push(l1r + (j - 1.0) * lrho - 0.5 * (LN_2PI + var.ln()));
                    t.2.push(0.5 / var);
                }
            }
            buf.clear();
            let (c, h) = (&t.1[..j_max], &t.2[..j_max]);
            for jj in 0..j_max {
                let d = m - (jj + 1) as f64 * l.u;
                buf.push(lr + c[jj] - d * d * h[jj]);
            }
        });
        l0
    }
}

// ------------------------------------------------------------------ segment structure
pub(crate) struct Pieces {
    pub n: usize,
    pub k: usize,
    pub dw: usize,
    pub gc: usize,
    pub ms: Vec<f64>,
    pub ws: Vec<f64>,
    pub valid: Vec<bool>,
    pub na: Vec<usize>,
    pub lag_off: Vec<usize>,
    pub lag_bins: Vec<usize>, // inside pieces' lag bins for segment (i,a): lag_bins[lag_off[s]..lag_off[s+1]]
    pub gap: Vec<i64>,
    pub gbin: Vec<usize>,
    pub lf: Vec<f64>,
}

fn round_half_even(x: f64) -> f64 {
    x.round_ties_even()
}

impl Pieces {
    pub fn new(
        m: &[f64],
        c: &[f64],
        st: &[f64],
        en: &[f64],
        dw: usize,
        k: Option<usize>,
        gc: Option<usize>,
        old_validity: bool,
    ) -> Self {
        let n = m.len();
        let k = k.unwrap_or_else(|| {
            let wmax = (0..n).map(|i| en[i] - st[i]).fold(0.0f64, f64::max).trunc();
            let mut kk = 1usize;
            for i in 0..n {
                let lim = st[i] + 2.0 * dw as f64 + 2.0 + wmax;
                let cnt = st.partition_point(|&x| x <= lim) - i; // searchsorted 'right' minus i
                kk = kk.max(cnt);
            }
            kk
        });
        let ns = n * k;
        let (mut ms, mut ws, mut valid, mut na) = (
            vec![0.0; ns],
            vec![0.0; ns],
            vec![false; ns],
            vec![0usize; ns],
        );
        let mut lag_off = vec![0usize; ns + 1];
        let mut lag_bins = Vec::new();
        let dwf = dw as f64;
        for i in 0..n {
            let mut cum = 0.0;
            let mut par = i; // running argmax (first on ties)
            for a in 0..k {
                let s = i * k + a;
                let b = i + a;
                if b < n {
                    cum += m[b];
                    if m[b] > m[par] {
                        par = b;
                    }
                }
                ms[s] = cum;
                let last = b.min(n - 1);
                ws[s] = en[last] - st[i] + 2.0;
                let mut ok = b < n;
                if ok {
                    let mut bins = Vec::new();
                    for q in i..=b {
                        if q == par {
                            continue;
                        }
                        let d = c[q] - c[par];
                        let lag = round_half_even(d);
                        if old_validity {
                            if d.abs() > dwf {
                                ok = false;
                            }
                        } else if lag.abs() > dwf {
                            ok = false;
                        }
                        bins.push((lag.max(-dwf).min(dwf) + dwf) as usize);
                    }
                    if old_validity && a > 0 && en[last] - st[i] > 2.0 * dwf {
                        ok = false;
                    }
                    if ok {
                        na[s] = bins.len();
                        lag_bins.extend(bins);
                    }
                }
                valid[s] = ok;
                lag_off[s + 1] = lag_bins.len();
            }
        }
        let gc = gc.unwrap_or(2 * dw + 3);
        let mut gap = vec![0i64; n];
        let mut gbin = vec![0usize; n];
        for i in 1..n {
            gap[i] = (st[i] - st[i - 1]) as i64;
            gbin[i] = (gap[i].max(0) as usize).min(gc + 1);
        }
        let mut lf = vec![0.0; k + 2];
        for q in 1..k + 2 {
            lf[q] = lf[q - 1] + (q as f64).ln();
        }
        Pieces {
            n,
            k,
            dw,
            gc,
            ms,
            ws,
            valid,
            na,
            lag_off,
            lag_bins,
            gap,
            gbin,
            lf,
        }
    }

    pub fn log_pgap(&self, th: &Theta, i: usize) -> f64 {
        let b = self.gbin[i];
        if b <= self.gc {
            th.pg[b].ln()
        } else {
            let exc = (self.gap[i] - self.gc as i64 - 1).max(0) as f64;
            th.pg[self.gc + 1].ln() + (-th.q).ln_1p() + exc * th.q.ln()
        }
    }

    /// Log segment terms without the boundary prior; NEG_INFINITY where invalid.
    pub fn seg_terms(
        &self,
        sx: f64,
        sn: f64,
        u: f64,
        th: &Theta,
        positions: bool,
        norm_split: bool,
    ) -> Vec<f64> {
        self.seg_terms_lt(sx, sn, u, th, positions, norm_split).0
    }

    /// [`Pieces::seg_terms`], also returning each valid segment's log lattice density (what `Lat::logp` gives), which
    /// the E-step needs again.
    pub fn seg_terms_lt(
        &self,
        sx: f64,
        sn: f64,
        u: f64,
        th: &Theta,
        positions: bool,
        norm_split: bool,
    ) -> (Vec<f64>, Vec<f64>) {
        let (snf, sw, eta) = th.null_parts(sn);
        let lat = Lat {
            sx,
            sn: snf,
            lam: th.lam,
            u,
            s1: th.s1,
            rho: th.rho,
            sw,
            eta,
        };
        let lpj: Vec<f64> = th.pj.iter().map(|p| p.ln()).collect();
        let gt: Vec<f64> = (0..self.n)
            .map(|i| {
                if positions && i > 0 {
                    self.log_pgap(th, i)
                } else {
                    0.0
                }
            })
            .collect();
        let lat = LatK::new(lat);
        let mut buf = Vec::new();
        let mut s_out = vec![f64::NEG_INFINITY; self.n * self.k];
        let mut tot_out = vec![f64::NEG_INFINITY; self.n * self.k];
        for i in 0..self.n {
            for a in 0..self.k {
                let s = i * self.k + a;
                if !self.valid[s] {
                    continue;
                }
                let mm = self.ms[s];
                let na = self.na[s] as f64;
                let l0 = lat.parts(mm, self.ws[s], lat.jmax(mm), &mut buf);
                let mut v = logaddexp(l0, logsumexp(&buf));
                tot_out[s] = v;
                let lm = mm.max(1e-300).ln();
                if norm_split {
                    v += self.lf[self.na[s] + 1] - na * lm;
                } else {
                    v += na * (2f64.ln() - lm);
                }
                if positions {
                    v += self.lf[self.na[s]];
                    for &bn in &self.lag_bins[self.lag_off[s]..self.lag_off[s + 1]] {
                        v += lpj[bn];
                    }
                    v += gt[i];
                }
                s_out[s] = v;
            }
        }
        (s_out, tot_out)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Theta {
    pub lam: f64,
    pub s1: f64,
    pub rho: f64,
    pub pi: f64,
    pub pj: Vec<f64>,
    pub pg: Vec<f64>,
    pub q: f64,
    pub sn: Option<f64>,
    pub sf: Option<f64>,
    pub sw: Option<f64>,
    pub eta: Option<f64>,
}

impl Theta {
    pub fn init(pc: &Pieces, u: f64, s1: f64, rho: f64, lam: f64, pi: f64) -> Self {
        let nb = 2 * pc.dw + 1;
        Theta {
            lam,
            s1: s1 * u,
            rho,
            pi,
            pj: vec![1.0 / nb as f64; nb],
            pg: vec![1.0 / (pc.gc + 2) as f64; pc.gc + 2],
            q: 0.5,
            sn: None,
            sf: None,
            sw: None,
            eta: None,
        }
    }
    /// (s_f or sn, s_w, eta): two-component null if sf/sw/eta set, else one half-normal (fitted sn if set, else `sn`).
    pub fn null_parts(&self, sn: f64) -> (f64, f64, f64) {
        match (self.sf, self.sw, self.eta) {
            (Some(f), Some(w), Some(e)) => (f, w, e),
            _ => (self.sn.unwrap_or(sn), 1.0, 0.0),
        }
    }
}

pub(crate) fn with_prior(s: &[f64], k: usize, pi: f64) -> Vec<f64> {
    let l1p = (-pi).ln_1p();
    let lpi = pi.ln();
    s.iter()
        .enumerate()
        .map(|(idx, &v)| {
            let a = (idx % k) as f64;
            let pr = if pi > 0.0 {
                a * lpi
            } else if a > 0.0 {
                f64::NEG_INFINITY
            } else {
                0.0
            };
            v + pr + l1p
        })
        .collect()
}

/// Returns log Z and segment posteriors P (n*k).
pub(crate) fn fwd_bwd(s: &[f64], n: usize, k: usize) -> (f64, Vec<f64>) {
    let mut f = vec![f64::NEG_INFINITY; n + 1];
    f[0] = 0.0;
    let mut g = vec![f64::NEG_INFINITY; n + 1];
    g[n] = 0.0;
    let mut tmp = Vec::with_capacity(k);
    for j in 1..=n {
        tmp.clear();
        for b in 0..k.min(j) {
            tmp.push(f[j - 1 - b] + s[(j - 1 - b) * k + b]);
        }
        f[j] = logsumexp(&tmp);
    }
    for i in (0..n).rev() {
        tmp.clear();
        for a in 0..k.min(n - i) {
            tmp.push(s[i * k + a] + g[i + a + 1]);
        }
        g[i] = logsumexp(&tmp);
    }
    let lz = f[n];
    let mut p = vec![0.0; n * k];
    for i in 0..n {
        for a in 0..k {
            let gi = g[(i + a + 1).min(n)];
            let v = (f[i] + s[i * k + a] + gi - lz).exp();
            p[i * k + a] = if v.is_finite() { v } else { 0.0 };
        }
    }
    (lz, p)
}

fn log_prior(th: &Theta, positions: bool) -> f64 {
    if !positions {
        return 0.0;
    }
    EPS * (th.pj.iter().map(|p| p.ln()).sum::<f64>() + th.pg.iter().map(|p| p.ln()).sum::<f64>())
}

/// scipy.optimize.fminbound (bounded Brent), ported line for line.
pub(crate) fn fminbound<F: Fn(f64) -> f64>(
    func: F,
    x1: f64,
    x2: f64,
    xatol: f64,
    maxfun: usize,
) -> f64 {
    let sqrt_eps = (2.2e-16f64).sqrt();
    let golden_mean = 0.5 * (3.0 - 5f64.sqrt());
    let (mut a, mut b) = (x1, x2);
    let mut fulc = a + golden_mean * (b - a);
    let (mut nfc, mut xf) = (fulc, fulc);
    let (mut rat, mut e) = (0.0f64, 0.0f64);
    let mut x;
    let mut fx = func(xf);
    let mut num = 1usize;
    let (mut ffulc, mut fnfc) = (fx, fx);
    let mut xm = 0.5 * (a + b);
    let mut tol1 = sqrt_eps * xf.abs() + xatol / 3.0;
    let mut tol2 = 2.0 * tol1;
    let sign = |v: f64| {
        if v > 0.0 {
            1.0
        } else if v < 0.0 {
            -1.0
        } else {
            0.0
        }
    };
    while (xf - xm).abs() > (tol2 - 0.5 * (b - a)) {
        let mut golden = true;
        if e.abs() > tol1 {
            golden = false;
            let mut r = (xf - nfc) * (fx - ffulc);
            let mut q = (xf - fulc) * (fx - fnfc);
            let mut p = (xf - fulc) * q - (xf - nfc) * r;
            q = 2.0 * (q - r);
            if q > 0.0 {
                p = -p;
            }
            q = q.abs();
            r = e;
            e = rat;
            if p.abs() < (0.5 * q * r).abs() && p > q * (a - xf) && p < q * (b - xf) {
                rat = (p + 0.0) / q;
                x = xf + rat;
                if (x - a) < tol2 || (b - x) < tol2 {
                    let si = sign(xm - xf) + if xm - xf == 0.0 { 1.0 } else { 0.0 };
                    rat = tol1 * si;
                }
            } else {
                golden = true;
            }
        }
        if golden {
            e = if xf >= xm { a - xf } else { b - xf };
            rat = golden_mean * e;
        }
        let si = sign(rat) + if rat == 0.0 { 1.0 } else { 0.0 };
        x = xf + si * rat.abs().max(tol1);
        let fu = func(x);
        num += 1;
        if fu <= fx {
            if x >= xf {
                a = xf;
            } else {
                b = xf;
            }
            fulc = nfc;
            ffulc = fnfc;
            nfc = xf;
            fnfc = fx;
            xf = x;
            fx = fu;
        } else {
            if x < xf {
                a = x;
            } else {
                b = x;
            }
            if fu <= fnfc || nfc == xf {
                fulc = nfc;
                ffulc = fnfc;
                nfc = x;
                fnfc = fu;
            } else if fu <= ffulc || fulc == xf || fulc == nfc {
                fulc = x;
                ffulc = fu;
            }
        }
        xm = 0.5 * (a + b);
        tol1 = sqrt_eps * xf.abs() + xatol / 3.0;
        tol2 = 2.0 * tol1;
        if num >= maxfun {
            break;
        }
    }
    xf
}

pub(crate) struct Opts {
    pub positions: bool,
    pub norm_split: bool,
    pub fix_pi: Option<f64>,
    pub fit_sn: bool,
    pub null2: bool,
    pub fix_pos: bool,
    pub iters: usize,
    pub tol: f64,
}

pub(crate) struct EmOut {
    pub obj: f64,
    pub th: Theta,
    pub trace: Vec<f64>,
}

pub(crate) fn em(pc: &Pieces, sx: f64, sn: f64, u: f64, th0: &Theta, o: &Opts) -> EmOut {
    let (n, k) = (pc.n, pc.k);
    let mut th = th0.clone();
    if o.fit_sn && th.sn.is_none() {
        th.sn = Some(sn);
    }
    if o.null2 {
        let b = sn.max(sx);
        if th.sf.is_none() {
            th.sf = Some(b);
        }
        if th.sw.is_none() {
            th.sw = Some(3.0 * b);
        }
        if th.eta.is_none() {
            th.eta = Some(0.2);
        }
    }
    if let Some(p) = o.fix_pi {
        th.pi = p;
    }
    let mut trace = Vec::new();
    let mut buf = Vec::new();
    for it in 0..=o.iters {
        let sn_cur = if o.fit_sn { th.sn.unwrap() } else { sn };
        let (s, tots) = pc.seg_terms_lt(sx, sn_cur, u, &th, o.positions, o.norm_split);
        let (snf, sw_cur, eta_cur) = th.null_parts(sn_cur);
        let (lz, p) = fwd_bwd(&with_prior(&s, k, th.pi), n, k);
        trace.push(lz + log_prior(&th, o.positions));
        let tl = trace.len();
        if it == o.iters
            || (it > 2
                && (trace[tl - 1] - trace[tl - 2]).abs() < o.tol * trace[tl - 1].abs().max(1.0))
        {
            break;
        }
        // E-step over selected segments
        let sel: Vec<usize> = (0..n * k).filter(|&s| p[s] > 1e-15).collect();
        let mmax = sel
            .iter()
            .map(|&s| pc.ms[s])
            .fold(f64::NEG_INFINITY, f64::max);
        let jn = jrange(mmax, u, sx, th.s1, th.rho);
        let lat = LatK::new(Lat {
            sx,
            sn: snf,
            lam: th.lam,
            u,
            s1: th.s1,
            rho: th.rho,
            sw: sw_cur,
            eta: eta_cur,
        });
        let ns = sel.len();
        let (mut r0, mut p1) = (vec![0.0; ns], vec![0.0; ns]);
        let (mut jw, mut r2w) = (vec![0.0; jn], vec![0.0; jn]);
        for (r, &s) in sel.iter().enumerate() {
            let (mm, w, wg) = (pc.ms[s], pc.ws[s], p[s]);
            // per-segment range, as in logp (terms beyond it are below e^-TAIL)
            let l0 = lat.parts(mm, w, lat.jmax(mm).min(jn), &mut buf);
            let tot = tots[s]; // the same sum seg_terms formed over the same terms
            r0[r] = (l0 - tot).exp();
            let mut s1sum = 0.0;
            let cut = tot - SKIP;
            for (jj, &lv) in buf.iter().enumerate() {
                if lv <= cut {
                    continue; // responsibility under e^-SKIP
                }
                let rj = (lv - tot).exp();
                s1sum += rj;
                let wr = wg * rj;
                let d = mm - (jj + 1) as f64 * u;
                jw[jj] += wr;
                r2w[jj] += wr * d * d;
            }
            p1[r] = s1sum;
        }
        let (mut lo, mut hi) = (1e-12f64, 1e3f64);
        // the score depends on a segment only through its width: pool the weights per distinct width first
        let mut by_w: std::collections::BTreeMap<u64, (f64, f64)> =
            std::collections::BTreeMap::new();
        for (r, &s) in sel.iter().enumerate() {
            let e = by_w.entry(pc.ws[s].to_bits()).or_insert((0.0, 0.0));
            e.0 += p[s] * r0[r];
            e.1 += p[s] * p1[r];
        }
        let by_w: Vec<(f64, f64, f64)> = by_w
            .into_iter()
            .map(|(b, (a0, a1))| (f64::from_bits(b), a0, a1))
            .collect();
        for _ in 0..80 {
            let mid = (lo * hi).sqrt();
            if mid == lo || mid == hi {
                // the bracket is down to neighbouring floats: every later step returns this same midpoint
                lo = mid;
                hi = mid;
                break;
            }
            let d: f64 = by_w
                .iter()
                .map(|&(w, a0, a1)| -a0 * w + a1 * w / (mid * w).exp_m1().max(1e-300))
                .sum();
            if d > 0.0 {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        th.lam = (lo * hi).sqrt();
        // rho
        let (mut num, mut den) = (0.0, 0.0);
        for (jj, &v) in jw.iter().enumerate() {
            num += v * (jj + 1) as f64;
            den += v;
        }
        let ej = num / den.max(1e-300);
        th.rho = (1.0 - 1.0 / ej.max(1.0 + 1e-12))
            .max(1e-12)
            .min(1.0 - 1e-12);
        // s1 (exact 1-D maximisation)
        let keep: Vec<(f64, f64, f64)> = (0..jn)
            .filter(|&jj| jw[jj] > 0.0)
            .map(|jj| ((jj + 1) as f64, jw[jj], r2w[jj]))
            .collect();
        let sx2 = sx * sx;
        let neg_q = |ls: f64| -> f64 {
            let e2 = (2.0 * ls).exp();
            -keep
                .iter()
                .map(|&(j, w, r2)| {
                    let v = sx2 + j * e2;
                    w * (-0.5 * v.ln()) - 0.5 * r2 / v
                })
                .sum::<f64>()
        };
        th.s1 = fminbound(neg_q, (1e-7 * u).ln(), (20.0 * u).ln(), 1e-12, 500).exp();
        if o.fit_sn {
            let (mut w0, mut wm) = (0.0, 0.0);
            for (r, &s) in sel.iter().enumerate() {
                w0 += p[s] * r0[r];
                wm += p[s] * r0[r] * pc.ms[s] * pc.ms[s];
            }
            if w0 > 0.0 {
                th.sn = Some((wm / w0).sqrt().max(sx));
            }
        }
        if o.null2 {
            // two-component null: sub-responsibilities inside the null, exact weighted MLEs
            let (mut s0, mut sa_w, mut sa_f, mut mw, mut mf) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for (r, &s) in sel.iter().enumerate() {
                let mm = pc.ms[s];
                let lf_ = (-eta_cur).ln_1p() + log_hn(mm, snf);
                let lw_ = eta_cur.ln() + log_hn(mm, sw_cur);
                let rw = (lw_ - logaddexp(lf_, lw_)).exp();
                let a0 = p[s] * r0[r];
                let aw = a0 * rw;
                let af = a0 - aw;
                s0 += a0;
                sa_w += aw;
                sa_f += af;
                mw += aw * mm * mm;
                mf += af * mm * mm;
            }
            if s0 > 0.0 {
                let mut e = (sa_w / s0).max(1e-12).min(1.0 - 1e-12);
                let mut f = snf;
                let mut w = sw_cur;
                if sa_f > 0.0 {
                    f = (mf / sa_f).sqrt().max(sx);
                }
                if sa_w > 0.0 {
                    w = (mw / sa_w).sqrt().max(sx);
                }
                if w < f {
                    std::mem::swap(&mut f, &mut w);
                    e = 1.0 - e;
                }
                th.sf = Some(f);
                th.sw = Some(w);
                th.eta = Some(e);
            }
        }
        if o.fix_pi.is_none() {
            let joins: f64 = (0..n * k).map(|s| p[s] * (s % k) as f64).sum();
            th.pi = (joins / n as f64).max(1e-12).min(1.0 - 1e-12);
        }
        if o.positions && !o.fix_pos {
            // fix_pos: p_join/p_gap/q are shared nuisances held fixed (no M-step)
            let mut cj = vec![0.0; 2 * pc.dw + 1];
            for s in 0..n * k {
                if pc.valid[s] {
                    for &bn in &pc.lag_bins[pc.lag_off[s]..pc.lag_off[s + 1]] {
                        cj[bn] += p[s];
                    }
                }
            }
            let tot: f64 = cj.iter().map(|v| v + EPS).sum();
            th.pj = cj.iter().map(|v| (v + EPS) / tot).collect();
            let mut cut: Vec<f64> = (0..n).map(|i| (0..k).map(|a| p[i * k + a]).sum()).collect();
            cut[0] = 0.0;
            let mut cg = vec![0.0; pc.gc + 2];
            for i in 0..n {
                cg[pc.gbin[i]] += cut[i];
            }
            let tot: f64 = cg.iter().map(|v| v + EPS).sum();
            th.pg = cg.iter().map(|v| (v + EPS) / tot).collect();
            let (mut wt, mut we) = (0.0, 0.0);
            for i in 0..n {
                if pc.gbin[i] == pc.gc + 1 {
                    wt += cut[i];
                    we += cut[i] * (pc.gap[i] - pc.gc as i64 - 1) as f64;
                }
            }
            if wt > 0.0 {
                let e = we / wt;
                th.q = (e / (1.0 + e)).max(1e-12).min(1.0 - 1e-12);
            }
        }
    }
    EmOut {
        obj: *trace.last().unwrap(),
        th,
        trace,
    }
}

pub(crate) fn fit(pc: &Pieces, sx: f64, sn: f64, u: f64, starts: &[Theta], o: &Opts) -> EmOut {
    let mut best: Option<EmOut> = None;
    for s in starts {
        let r = em(pc, sx, sn, u, s, o);
        if best.as_ref().is_none_or(|b| r.obj > b.obj) {
            best = Some(r);
        }
    }
    best.unwrap()
}

/// Expected counts at theta: posterior-mean count sum_s P(s) E[j | s], and the expected per-segment MAP count
/// sum_s P(s) argmax_{j in 0..} R(j | s) (j = 0 is the null).
pub(crate) fn counts(pc: &Pieces, sx: f64, sn: f64, u: f64, th: &Theta, o: &Opts) -> (f64, f64) {
    let k = pc.k;
    let sn_cur = th.sn.unwrap_or(sn);
    let s = pc.seg_terms(sx, sn_cur, u, th, o.positions, o.norm_split);
    let (_, p) = fwd_bwd(&with_prior(&s, k, th.pi), pc.n, k);
    let (snf, sw, eta) = th.null_parts(sn_cur);
    let lat = Lat {
        sx,
        sn: snf,
        lam: th.lam,
        u,
        s1: th.s1,
        rho: th.rho,
        sw,
        eta,
    };
    let mut buf = Vec::new();
    let (mut pm, mut mp) = (0.0, 0.0);
    for idx in 0..pc.n * k {
        if p[idx] <= 1e-15 {
            continue;
        }
        let jn = jrange(pc.ms[idx], u, sx, th.s1, th.rho);
        let l0 = lat.parts(pc.ms[idx], pc.ws[idx], jn, &mut buf);
        let tot = logaddexp(l0, logsumexp(&buf));
        let mut ej = 0.0;
        let (mut best, mut bj) = (l0, 0usize);
        for (jj, &lv) in buf.iter().enumerate() {
            ej += (jj + 1) as f64 * (lv - tot).exp();
            if lv > best {
                best = lv;
                bj = jj + 1;
            }
        }
        pm += p[idx] * ej;
        mp += p[idx] * bj as f64;
    }
    (pm, mp)
}

// ------------------------------------------------------------------ normal CDF (log domain), for the smoothed lattice
const SQRT_PI: f64 = 1.7724538509055159;

#[cfg(test)]
/// erf(x) for 0 <= x < 3 by the all-positive series erf(x) = 2x/sqrt(pi) e^{-x^2} sum_n (2x^2)^n / (1*3*...*(2n+1)).
fn erf_series(x: f64) -> f64 {
    let x2 = x * x;
    let (mut term, mut sum) = (1.0f64, 1.0f64);
    let mut n = 0.0;
    loop {
        n += 1.0;
        term *= 2.0 * x2 / (2.0 * n + 1.0);
        sum += term;
        if term < 1e-17 * sum || n > 500.0 {
            break;
        }
    }
    2.0 * x / SQRT_PI * (-x2).exp() * sum
}
/// ln erfc(x) for x >= 2.5 by the Lentz continued fraction erfc(x) = e^{-x^2}/sqrt(pi) * 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + ...)))).
fn ln_erfc_cf(x: f64) -> f64 {
    let tiny = 1e-300;
    let mut f = x;
    let mut c = x;
    let mut d = 0.0;
    let mut k = 1.0f64;
    loop {
        let a = k / 2.0;
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
        k += 1.0;
        if (delta - 1.0).abs() < 1e-16 || k > 5000.0 {
            break;
        }
    }
    -x * x - SQRT_PI.ln() - f.ln()
}
#[cfg(test)]
/// ln erfc(x), x >= 0, by the series below 2.5 and the continued fraction above (the reference the fast version is
/// checked against).
fn ln_erfc_ref(x: f64) -> f64 {
    if x < 2.5 {
        (1.0 - erf_series(x)).ln()
    } else {
        ln_erfc_cf(x)
    }
}

#[inline]
fn poly(z: f64, c: &[f64]) -> f64 {
    c.iter().rev().fold(0.0, |acc, &v| acc * z + v)
}

/// ln erfc(x), x >= 0: the rational approximations of fdlibm's `erfc` (Sun Microsystems, s_erf.c; error under 1 ulp
/// in erfc), taken in the log domain above 1.25 so that nothing underflows; the continued fraction beyond their range.
// The coefficients are written with the digits fdlibm publishes.
#[allow(clippy::excessive_precision)]
fn ln_erfc_pos(x: f64) -> f64 {
    const ERX: f64 = 8.45062911510467529297e-01;
    const PP: [f64; 5] = [
        1.28379167095512558561e-01,
        -3.25042107247001499370e-01,
        -2.84817495755985104766e-02,
        -5.77027029648944159157e-03,
        -2.37630166566501626084e-05,
    ];
    const QQ: [f64; 6] = [
        1.0,
        3.97917223959155352819e-01,
        6.50222499887672944485e-02,
        5.08130628187576562776e-03,
        1.32494738004321644526e-04,
        -3.96022827877536812320e-06,
    ];
    const PA: [f64; 7] = [
        -2.36211856075265944077e-03,
        4.14856118683748331666e-01,
        -3.72207876035701323847e-01,
        3.18346619901161753674e-01,
        -1.10894694282396677476e-01,
        3.54783043256182359371e-02,
        -2.16637559486879084300e-03,
    ];
    const QA: [f64; 7] = [
        1.0,
        1.06420880400844228286e-01,
        5.40397917702171048937e-01,
        7.18286544141962662868e-02,
        1.26171219808761642112e-01,
        1.36370839120290507362e-02,
        1.19844998467991074170e-02,
    ];
    const RA: [f64; 8] = [
        -9.86494403484714822705e-03,
        -6.93858572707181764372e-01,
        -1.05586262253232909814e+01,
        -6.23753324503260060396e+01,
        -1.62396669462573470355e+02,
        -1.84605092906711035994e+02,
        -8.12874355063065934246e+01,
        -9.81432934416914548592e+00,
    ];
    const SA: [f64; 9] = [
        1.0,
        1.96512716674392571292e+01,
        1.37657754143519042600e+02,
        4.34565877475229228821e+02,
        6.45387271733267880336e+02,
        4.29008140027567833386e+02,
        1.08635005541779435134e+02,
        6.57024977031928170135e+00,
        -6.04244152148580987438e-02,
    ];
    const RB: [f64; 7] = [
        -9.86494292470009928597e-03,
        -7.99283237680523006574e-01,
        -1.77579549177547519889e+01,
        -1.60636384855821916062e+02,
        -6.37566443368389627722e+02,
        -1.02509513161107724954e+03,
        -4.83519191608651397019e+02,
    ];
    const SB: [f64; 8] = [
        1.0,
        3.03380607434824582924e+01,
        3.25792512996573918826e+02,
        1.53672958608443695994e+03,
        3.19985821950859553908e+03,
        2.55305040643316442583e+03,
        4.74528541206955367215e+02,
        -2.24409524465858183362e+01,
    ];
    if x < 0.84375 {
        let z = x * x;
        let y = poly(z, &PP) / poly(z, &QQ);
        let v = if x < 0.25 {
            1.0 - (x + x * y)
        } else {
            0.5 - (x * y + (x - 0.5))
        };
        v.ln()
    } else if x < 1.25 {
        let s = x - 1.0;
        (1.0 - ERX - poly(s, &PA) / poly(s, &QA)).ln()
    } else if x < 28.0 {
        let s = 1.0 / (x * x);
        let rs = if x < 1.0 / 0.35 {
            poly(s, &RA) / poly(s, &SA)
        } else {
            poly(s, &RB) / poly(s, &SB)
        };
        -x * x - 0.5625 + rs - x.ln()
    } else {
        ln_erfc_cf(x)
    }
}
/// ln Phi(z) (standard normal CDF), accurate in both tails.
pub(crate) fn log_ndtr(z: f64) -> f64 {
    let x = z.abs() / std::f64::consts::SQRT_2;
    if z < 0.0 {
        0.5f64.ln() + ln_erfc_pos(x)
    } else {
        (-0.5 * ln_erfc_pos(x).exp()).ln_1p()
    }
}
/// ln(Phi(hi) - Phi(lo)), hi > lo, stable on either side.
pub(crate) fn log_phi_diff(hi: f64, lo: f64) -> f64 {
    if hi < 0.0 {
        let (a, b) = (log_ndtr(hi), log_ndtr(lo));
        a + (-(b - a).min(-1e-300).exp()).ln_1p()
    } else {
        let (a, b) = (log_ndtr(-lo), log_ndtr(-hi));
        a + (-(b - a).min(-1e-300).exp()).ln_1p()
    }
}

impl Lat {
    /// Event density smoothed over one lattice period (convolved with U(-u/2, u/2)): kills every harmonic at k/u, keeps
    /// the envelope, null and nuisances. Returns the log segment density (null + smoothed events).
    pub fn logp_smooth(&self, m: f64, w: f64, buf: &mut Vec<f64>) -> f64 {
        let j_max = jrange(m, self.u, self.sx, self.s1, self.rho);
        let lp0 = -self.lam * w;
        let ln0 = if self.eta <= 0.0 {
            log_hn(m, self.sn)
        } else {
            logaddexp(
                (-self.eta).ln_1p() + log_hn(m, self.sn),
                self.eta.ln() + log_hn(m, self.sw),
            )
        };
        let lr = (-(lp0.exp_m1())).max(1e-300).ln();
        let (lrho, l1r, lu) = (self.rho.max(1e-300).ln(), (-self.rho).ln_1p(), self.u.ln());
        buf.clear();
        // Exact term at j, and a rigorous upper bound on it (the Gaussian's peak over the period interval times its
        // width u). Terms whose bound is TAIL below the best exact term are skipped (relative error < j_max e^-TAIL).
        let base = |j: f64| lr + l1r + (j - 1.0) * lrho - lu;
        let exact = |j: f64| {
            let sd = (self.sx * self.sx + j * self.s1 * self.s1).sqrt();
            base(j)
                + log_phi_diff(
                    (m - j * self.u + self.u / 2.0) / sd,
                    (m - j * self.u - self.u / 2.0) / sd,
                )
        };
        let bound = |j: f64| {
            let var = self.sx * self.sx + j * self.s1 * self.s1;
            let dmin = ((m - j * self.u).abs() - self.u / 2.0).max(0.0);
            base(j) + lu - 0.5 * (LN_2PI + var.ln()) - 0.5 * dmin * dmin / var
        };
        let j0 = ((m / self.u).round() as usize).clamp(1, j_max);
        let mut best = exact(j0 as f64).max(exact(1.0));
        for jj in 1..=j_max {
            let j = jj as f64;
            if bound(j) < best - TAIL {
                continue;
            }
            let v = exact(j);
            if v > best {
                best = v;
            }
            buf.push(v);
        }
        logaddexp(lp0 + ln0, logsumexp(buf))
    }
}

impl Pieces {
    /// log Z with the smoothed (period-averaged) event density; same split/position/boundary terms as seg_terms.
    pub fn logz_smooth(
        &self,
        sx: f64,
        sn: f64,
        u: f64,
        th: &Theta,
        positions: bool,
        norm_split: bool,
    ) -> f64 {
        let (snf, sw, eta) = th.null_parts(sn);
        let lat = Lat {
            sx,
            sn: snf,
            lam: th.lam,
            u,
            s1: th.s1,
            rho: th.rho,
            sw,
            eta,
        };
        let mut s = self.seg_terms(sx, sn, u, th, positions, norm_split); // reuse all non-lattice terms
        let mut buf = Vec::new();
        for idx in 0..self.n * self.k {
            if !self.valid[idx] {
                continue;
            }
            let d = lat.logp_smooth(self.ms[idx], self.ws[idx], &mut buf)
                - lat.logp(self.ms[idx], self.ws[idx], &mut buf);
            s[idx] += d;
        }
        fwd_bwd(&with_prior(&s, self.k, th.pi), self.n, self.k).0
    }
}

// ------------------------------------------------------------------ the pick used by CaDecon's binarization
/// Most probable contiguous partition (max-product version of `fwd_bwd`): segments as (first piece, last piece).
pub(crate) fn viterbi(s: &[f64], n: usize, k: usize) -> Vec<(usize, usize)> {
    let mut best = vec![f64::NEG_INFINITY; n + 1];
    best[0] = 0.0;
    let mut back = vec![0usize; n + 1];
    for j in 1..=n {
        for b in 0..k.min(j) {
            let v = best[j - 1 - b] + s[(j - 1 - b) * k + b];
            if v > best[j] {
                best[j] = v;
                back[j] = b;
            }
        }
    }
    let mut segs = Vec::new();
    let mut j = n;
    while j > 0 {
        let b = back[j];
        segs.push((j - 1 - b, j - 1));
        j -= 1 + b;
    }
    segs.reverse();
    segs
}

/// Dense proxy grid size and number of proxy peaks scored with the full split sum in [`select_alpha`].
const DENSE: usize = 400;
const N_PEAKS: usize = 6;

/// One grid of unit sizes at a fixed null scale: per unit, (log Z lattice, log Z period-smoothed, fitted theta).
/// Units where this null scale is not allowed (sn > u/2, unless `always`) are skipped: they never enter log BF.
fn grid_fit(
    pc: &Pieces,
    sx: f64,
    sn: f64,
    us: &[f64],
    o: &Opts,
    always: bool,
) -> Vec<(f64, f64, Theta)> {
    let mut out = Vec::with_capacity(us.len());
    let mut prev: Option<(Theta, f64)> = None;
    for &u in us {
        if !always && sn > u / 2.0 {
            out.push((
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
                Theta::init(pc, u, 0.3, 0.5, 0.02, 0.1),
            ));
            continue;
        }
        let mut starts = vec![
            Theta::init(pc, u, 0.3, 0.5, 0.02, 0.1),
            Theta::init(pc, u, 0.05, 0.5, 0.02, 0.1),
        ];
        match &prev {
            Some((t, pu)) => {
                let mut w = t.clone();
                w.s1 *= u / pu;
                starts.push(w);
            }
            None => starts.push(Theta::init(pc, u, 1.0, 0.9, 0.02, 0.1)),
        }
        let r = fit(pc, sx, sn, u, &starts, o);
        let s = pc.seg_terms(sx, sn, u, &r.th, o.positions, o.norm_split);
        let lz = fwd_bwd(&with_prior(&s, pc.k, r.th.pi), pc.n, pc.k).0;
        let ls = pc.logz_smooth(sx, sn, u, &r.th, o.positions, o.norm_split);
        prev = Some((r.th.clone(), u));
        out.push((lz, ls, r.th));
    }
    out
}

/// The result of [`select_alpha`].
pub(crate) struct SplitPick {
    /// Spike size (units of the piece masses).
    pub alpha: f64,
    /// Most probable segments (first piece, last piece) and their most probable spike counts (0 = noise).
    pub segments: Vec<(usize, usize, usize)>,
    /// log Bayes factor of the lattice over its period-smoothed version at the pick (nats).
    pub log_bf: f64,
}

/// Choose the spike size by the discreteness Bayes factor with the null scale integrated out: for each candidate unit
/// u, log BF(u) = log sum_s Z(u; lattice, s) - log sum_s Z(u; smoothed, s) over null scales s = mult * sx with
/// s <= u/2 (the smallest always allowed; a log-uniform prior, whose normalisation cancels). alpha = argmax log BF.
/// Counts: the most probable partition at alpha (with the null scale of highest evidence there), and per segment the
/// most probable count including 0.
pub(crate) fn select_alpha(pc: &Pieces, sx: f64, us: &[f64], mults: &[f64], o: &Opts) -> SplitPick {
    let grids: Vec<Vec<(f64, f64, Theta)>> = mults
        .iter()
        .enumerate()
        .map(|(q, &m)| grid_fit(pc, sx, m * sx, us, o, q == 0))
        .collect();
    let (mut best_k, mut best_bf) = (0usize, f64::NEG_INFINITY);
    for (ku, &u) in us.iter().enumerate() {
        let allow: Vec<usize> = (0..mults.len())
            .filter(|&q| q == 0 || mults[q] * sx <= u / 2.0)
            .collect();
        let lz: Vec<f64> = allow.iter().map(|&q| grids[q][ku].0).collect();
        let ls: Vec<f64> = allow.iter().map(|&q| grids[q][ku].1).collect();
        let bf = logsumexp(&lz) - logsumexp(&ls);
        if bf > best_bf {
            best_bf = bf;
            best_k = ku;
        }
    }
    // Refine alpha continuously between the neighbouring grid points (bounded Brent on log u): with little noise the
    // lattice is sharp and a fixed grid would favour a finer unit that happens to line up.
    let lo_k = best_k.saturating_sub(1);
    let hi_k = (best_k + 1).min(us.len() - 1);
    let bf_at = |u: f64| -> (f64, Vec<(f64, f64, Theta)>) {
        let fits: Vec<(f64, f64, Theta)> = mults
            .iter()
            .enumerate()
            .map(|(q, &m)| {
                let sn = m * sx;
                let seed = &grids[q][best_k].2;
                if q != 0 && sn > u / 2.0 {
                    return (f64::NEG_INFINITY, f64::NEG_INFINITY, seed.clone());
                }
                let mut w = seed.clone();
                w.s1 *= u / us[best_k];
                let starts = vec![
                    w,
                    Theta::init(pc, u, 0.3, 0.5, 0.02, 0.1),
                    Theta::init(pc, u, 0.05, 0.5, 0.02, 0.1),
                ];
                let r = fit(pc, sx, sn, u, &starts, o);
                let s = pc.seg_terms(sx, sn, u, &r.th, o.positions, o.norm_split);
                let lz = fwd_bwd(&with_prior(&s, pc.k, r.th.pi), pc.n, pc.k).0;
                let ls = pc.logz_smooth(sx, sn, u, &r.th, o.positions, o.norm_split);
                (lz, ls, r.th)
            })
            .collect();
        let allow: Vec<usize> = (0..mults.len())
            .filter(|&q| q == 0 || mults[q] * sx <= u / 2.0)
            .collect();
        let lz: Vec<f64> = allow.iter().map(|&q| fits[q].0).collect();
        let ls: Vec<f64> = allow.iter().map(|&q| fits[q].1).collect();
        (logsumexp(&lz) - logsumexp(&ls), fits)
    };
    let (mut u, mut fits) = (
        us[best_k],
        grids.iter().map(|g| g[best_k].clone()).collect::<Vec<_>>(),
    );
    // The log BF profile in u is a comb of narrow peaks (sharp when sx << u), which a coarse grid samples badly and
    // with a bias toward finer units. Locate the peaks with a cheap proxy on a dense grid (the same Bayes factor on
    // the ungrouped pieces, prior fitted at the best grid point), score the best few with the full split sum, then
    // refine the winner continuously.
    let (lo_u, hi_u) = (us[0], us[us.len() - 1]);
    let th0 = &grids[0][best_k].2;
    let s1_rel = th0.s1 / us[best_k];
    let dense: Vec<f64> = (0..DENSE)
        .map(|i| (lo_u.ln() + (hi_u.ln() - lo_u.ln()) * i as f64 / (DENSE - 1) as f64).exp())
        .collect();
    let mut buf = Vec::new();
    let proxy: Vec<f64> = dense
        .iter()
        .map(|&du| {
            let lat = Lat {
                sx,
                sn: sx * mults[0],
                lam: th0.lam,
                u: du,
                s1: s1_rel * du,
                rho: th0.rho,
                sw: 1.0,
                eta: 0.0,
            };
            (0..pc.n)
                .map(|i| {
                    let idx = i * pc.k;
                    lat.logp(pc.ms[idx], pc.ws[idx], &mut buf)
                        - lat.logp_smooth(pc.ms[idx], pc.ws[idx], &mut buf)
                })
                .sum::<f64>()
        })
        .collect();
    let mut peaks: Vec<usize> = (0..DENSE)
        .filter(|&i| {
            (i == 0 || proxy[i] >= proxy[i - 1]) && (i + 1 == DENSE || proxy[i] >= proxy[i + 1])
        })
        .collect();
    peaks.sort_by(|&a, &b| proxy[b].total_cmp(&proxy[a]));
    peaks.truncate(N_PEAKS);
    let step = (hi_u.ln() - lo_u.ln()) / (DENSE - 1) as f64;
    let mut cand: Vec<f64> = peaks.iter().map(|&i| dense[i]).collect();
    cand.push(us[best_k]);
    let mut best_c = us[best_k];
    for &c in &cand {
        let (bf, f) = bf_at(c);
        if bf > best_bf {
            best_bf = bf;
            u = c;
            fits = f;
            best_c = c;
        }
    }
    // refine within one dense step either side (one coarse step if the grid point won)
    let half = if best_c == us[best_k] && hi_k > lo_k {
        0.5 * (us[hi_k].ln() - us[lo_k].ln())
    } else {
        step
    };
    let lu = fminbound(
        |lu: f64| -bf_at(lu.exp()).0,
        best_c.ln() - half,
        best_c.ln() + half,
        1e-5,
        14,
    )
    .exp();
    let (bf, f) = bf_at(lu);
    if bf > best_bf {
        best_bf = bf;
        u = lu;
        fits = f;
    }
    let q = (0..mults.len())
        .filter(|&q| q == 0 || mults[q] * sx <= u / 2.0)
        .max_by(|&a, &b| fits[a].0.total_cmp(&fits[b].0))
        .unwrap_or(0);
    let (sn, th) = (mults[q] * sx, &fits[q].2);
    let s = pc.seg_terms(sx, sn, u, th, o.positions, o.norm_split);
    let segs = viterbi(&with_prior(&s, pc.k, th.pi), pc.n, pc.k);
    let (snf, sw, eta) = th.null_parts(sn);
    let lat = Lat {
        sx,
        sn: snf,
        lam: th.lam,
        u,
        s1: th.s1,
        rho: th.rho,
        sw,
        eta,
    };
    let mut buf = Vec::new();
    let segments = segs
        .into_iter()
        .map(|(i, j)| {
            let idx = i * pc.k + (j - i);
            let jn = jrange(pc.ms[idx], u, sx, th.s1, th.rho);
            let l0 = lat.parts(pc.ms[idx], pc.ws[idx], jn, &mut buf);
            let (mut best, mut bj) = (l0, 0usize);
            for (jj, &lv) in buf.iter().enumerate() {
                if lv > best {
                    best = lv;
                    bj = jj + 1;
                }
            }
            (i, j, bj)
        })
        .collect();
    SplitPick {
        alpha: u,
        segments,
        log_bf: best_bf,
    }
}

#[cfg(test)]
mod pick_tests {
    use super::*;
    /// The fast ln erfc agrees with the series / continued-fraction reference over the whole range in use.
    #[test]
    fn ln_erfc_matches_the_reference() {
        let mut worst = 0.0f64;
        for i in 0..40000 {
            let x = i as f64 * 0.001;
            let (a, b) = (ln_erfc_pos(x), ln_erfc_ref(x));
            // the reference forms 1 - erf below 2.5, so its own error there is about 1e-16 / erfc(x)
            let tol = 1e-13_f64.max(4e-16 / b.exp().max(1e-300)).min(1e-11) * b.abs().max(1.0);
            assert!((a - b).abs() <= tol, "x {x}: {a} vs {b}");
            worst = worst.max((a - b).abs() / b.abs().max(1.0));
        }
        eprintln!("ln erfc worst relative difference {worst:.2e}");
    }
    /// Viterbi returns the single best partition: equal to brute force over all partitions on small inputs.
    #[test]
    fn viterbi_is_the_best_partition() {
        let mut seed = 7u64;
        let mut rnd = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((seed >> 11) as f64) / ((1u64 << 53) as f64)
        };
        for _ in 0..50 {
            let (n, k) = (7usize, 4usize);
            let s: Vec<f64> = (0..n * k)
                .map(|i| {
                    if i % k + i / k >= n {
                        f64::NEG_INFINITY
                    } else {
                        -5.0 * rnd()
                    }
                })
                .collect();
            let segs = viterbi(&s, n, k);
            let score =
                |sg: &[(usize, usize)]| sg.iter().map(|&(i, j)| s[i * k + (j - i)]).sum::<f64>();
            let mut best = f64::NEG_INFINITY;
            for cuts in 0..(1u32 << (n - 1)) {
                let mut sg = vec![];
                let mut st = 0;
                for p in 0..n - 1 {
                    if cuts >> p & 1 == 1 {
                        sg.push((st, p));
                        st = p + 1;
                    }
                }
                sg.push((st, n - 1));
                if sg.iter().all(|&(i, j)| j - i < k) {
                    best = best.max(score(&sg));
                }
            }
            assert!((score(&segs) - best).abs() < 1e-12);
        }
    }
    /// On pieces drawn from the model with clean quantisation, the pick lands on the true unit and counts are exact
    /// in total.
    #[test]
    fn select_alpha_recovers_the_unit_on_clean_pieces() {
        // 40 isolated events of 1-3 spikes (unit 1.0) plus 30 small noise fragments, spaced far apart
        let mut m = vec![];
        let mut c = vec![];
        let mut st = vec![];
        let mut en = vec![];
        let mut truth = 0usize;
        let mut seed = 3u64;
        let mut rnd = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((seed >> 11) as f64) / ((1u64 << 53) as f64)
        };
        let mut t = 10.0;
        for i in 0..70 {
            let (mass, w) = if i % 7 < 4 {
                let j = 1 + (rnd() * 3.0) as usize;
                truth += j;
                (j as f64 + 0.04 * (rnd() - 0.5), 3.0)
            } else {
                (0.06 * rnd(), 1.0)
            };
            m.push(mass);
            st.push(t);
            en.push(t + w);
            c.push(t + w / 2.0);
            t += 30.0;
        }
        let pc = Pieces::new(&m, &c, &st, &en, 10, None, None, false);
        let us: Vec<f64> = (0..25)
            .map(|i| 0.4 * (4.0f64).powf(i as f64 / 24.0))
            .collect();
        let o = Opts {
            positions: false,
            norm_split: true,
            fix_pi: None,
            fit_sn: false,
            null2: false,
            fix_pos: false,
            iters: 60,
            tol: 1e-7,
        };
        let p = select_alpha(&pc, 0.01, &us, &[1.0, 2.0, 4.0, 8.0], &o);
        let total: usize = p.segments.iter().map(|s| s.2).sum();
        assert!((p.alpha - 1.0).abs() < 0.07, "alpha {}", p.alpha);
        assert_eq!(total, truth, "counts {} vs {}", total, truth);
    }
}
