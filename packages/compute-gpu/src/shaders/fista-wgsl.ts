/**
 * WGSL for the batched banded-AR(2) FISTA. Kept as a template string so Vite
 * and Vitest import it without plugins. src/scan-reference.ts and
 * src/fista-reference.ts model this decomposition step for step in TS.
 *
 * Layout: cell-major flat buffers, index = cell * T + t. A "block" is
 * C = WG * K consecutive samples owned by one workgroup; block-level entry
 * points are dispatched as (nBlocks, nCells), per-cell ones as
 * ceil(nCells / 64). Every entry point returns early for converged cells.
 *
 * Per iteration there are two dispatches:
 *   sweep  one pass per block, reading x_k, x_{k-1} and the trace and writing
 *          x_{k+1} over x_{k-1} (two ping-pong buffers):
 *            y = x_k, or constrain(x_k + m (x_k - x_{k-1})) without a restart
 *            forward 2-state scan of y / peak from the block's carry-in s_in
 *            residual z = ((c + baseline) - trace) / peak, in registers
 *            reverse 2-state scan of z from the block's carry-in q_in
 *            prox, partial diff² / x_k² / dot, and per-block functionals of
 *            both next-iteration candidates (x_{k+1} and y_{k+1})
 *   fin    one thread per cell: FISTA bookkeeping (iteration, t, restart,
 *          convergence), then the carries for the next iteration (`carry`)
 *
 * The reverse block aggregate of the residual is not computed from the
 * residual: it is Q_b = (G s_in + Σ β_p x_p + baseline·O - Tr_b) / peak, with
 * host-computed G, β, O (scan-reference.ts `buildScanTables`) and the trace
 * term Tr_b computed once by `prep` at load.
 *
 * Restart: `fin` sets the cell's useX flag; the next `sweep` then uses
 * y = x_k (and does not read x_{k-1}), and `carry` picks the x candidate.
 * Initially useX = 1 (y_0 = x_0), or useX = 2 for a warm start that continues
 * momentum: y_0 was uploaded into the x_{k-1} slot (xb) and is used as is,
 * like Rust's `solution_prev` after `load_state`.
 *
 * `iter` counts iterations since load; `iter0` is the count carried in by a
 * warm start, so the restart (`iteration > 1`) and convergence
 * (`iteration > 5`) gates see Rust's cumulative count.
 */
/** The fused iteration entry point; `storedY` adds the useX = 2 case (first iteration only). */
function sweepEntry(name: string, storedY: boolean): string {
  const yRule = storedY
    ? `      if (st.useX == 2u) {
        y = readX(!odd, base + t);
      } else if (!useX) {
        y = constrain(xv + st.m * (xv - readX(!odd, base + t)));
      }`
    : `      if (!useX) { y = constrain(xv + st.m * (xv - readX(!odd, base + t))); }`;
  return SWEEP_TEMPLATE.replace('__NAME__', name).replace('__Y_RULE__', yRule);
}

const SWEEP_TEMPLATE = /* wgsl */ `
@compute @workgroup_size(WG)
fn __NAME__(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let cell = wid.y;
  let tid = lid.x;
  if (cellDone(cell, tid)) { return; }
  let base = cell * P.T;
  let st = cells[cell];
  let useX = st.useX != 0u;
  let odd = (st.iter & 1u) != 0u; // x_k in xb; x_{k-1} (and x_{k+1}) in xa
  let last = b == P.nBlocks - 1u;
  let o = rec(cell, b);
  let sIn = vec2<f32>(aux[o + R_SIN], aux[o + R_SIN + 1u]);
  let qIn = vec2<f32>(aux[o + R_QIN], aux[o + R_QIN + 1u]);
  var bl = 0.0;
  if (P.filtered == 0u) { bl = st.baseline; }

  var xk: array<f32, K>;
  var yv: array<f32, K>;
  var z: array<f32, K>;
  let t0 = b * C + tid * K;
  for (var k = 0u; k < K; k++) {
    let t = t0 + k;
    var xv = 0.0;
    var y = 0.0;
    if (t < P.T) {
      xv = readX(odd, base + t);
      y = xv;
__Y_RULE__
    }
    xk[k] = xv;
    yv[k] = y;
  }

  // Forward: thread-local cascade from zero (thread 0 from sIn), scan, rerun.
  var s = vec2<f32>(0.0);
  if (tid == 0u) { s = sIn; }
  for (var k = 0u; k < K; k++) {
    s.x = P.d * s.x + yv[k] * P.invPeak;
    s.y = P.r * s.y + s.x;
  }
  s = scanFwd(tid, s, sIn);
  for (var k = 0u; k < K; k++) {
    let t = t0 + k;
    var zv = 0.0;
    if (t < P.T) { zv = ((s.y + bl) - trace[base + t]) * P.invPeak; }
    z[k] = zv;
    s.x = P.d * s.x + yv[k] * P.invPeak;
    s.y = P.r * s.y + s.x;
  }

  // Reverse: thread-local from zero (last thread from qIn), scan, rerun.
  var q = vec2<f32>(0.0);
  if (tid == WG - 1u) { q = qIn; }
  for (var k = K; k > 0u; k--) {
    q.x = P.d * q.x + z[k - 1u];
    q.y = P.r * q.y + q.x;
  }
  q = scanRev(tid, q, qIn);

  // Prox (gradient at t is a_{t+1}: the state before consuming z[t]).
  let tNew = (1.0 + sqrt(1.0 + 4.0 * st.t * st.t)) * 0.5;
  let m = (st.t - 1.0) / tNew;
  var part = vec4<f32>(0.0); // diff², x_k², dot, Σδx of x_{k+1}
  var cX = vec4<f32>(0.0);   // F, Σβx of x_{k+1}
  var cY = vec4<f32>(0.0);   // F, Σβx of y_{k+1}
  var cYd = 0.0;             // Σδx of y_{k+1}
  for (var k = K; k > 0u; k--) {
    let kk = k - 1u;
    let g = q.y;
    q.x = P.d * q.x + z[kk];
    q.y = P.r * q.y + q.x;
    let t = t0 + kk;
    if (t < P.T) {
      let xo = xk[kk];
      let xn = constrain((yv[kk] - P.step * g) - P.thresh);
      let yn = constrain(xn + m * (xn - xo));
      writeX(!odd, base + t, xn);
      let dd = xn - xo;
      let p = tid * K + kk;
      let w0 = tab[T_POS0 + p];
      let w1 = tab[T_POS1 + p];
      let w2 = tab[T_POS2 + p];
      var beta = w1.xy;
      var delta = w2.x;
      if (last) { beta = w1.zw; delta = w2.y; }
      let sx = xn * P.invPeak;
      let sy = yn * P.invPeak;
      part = part + vec4<f32>(dd * dd, xo * xo, (yv[kk] - xn) * dd, delta * sx);
      cX = cX + vec4<f32>(w0.xy * sx, beta * sx);
      cY = cY + vec4<f32>(w0.xy * sy, beta * sy);
      cYd = cYd + delta * sy;
    }
  }
  reduce2(tid, part, cX);
  let partS = red0[0];
  let cXS = red1[0];
  workgroupBarrier();
  reduce2(tid, cY, vec4<f32>(cYd, 0.0, 0.0, 0.0));
  if (tid == 0u) {
    aux[o + R_PART] = partS.x;
    aux[o + R_PART + 1u] = partS.y;
    aux[o + R_PART + 2u] = partS.z;
    aux[o + R_CANDX] = cXS.x;
    aux[o + R_CANDX + 1u] = cXS.y;
    aux[o + R_CANDX + 2u] = cXS.z;
    aux[o + R_CANDX + 3u] = cXS.w;
    aux[o + R_CANDX + 4u] = partS.w;
    let cYS = red0[0];
    aux[o + R_CANDY] = cYS.x;
    aux[o + R_CANDY + 1u] = cYS.y;
    aux[o + R_CANDY + 2u] = cYS.z;
    aux[o + R_CANDY + 3u] = cYS.w;
    aux[o + R_CANDY + 4u] = red1[0].x;
  }
}

`;

export function fistaShaderSource(wg: number, k: number): string {
  const logWg = Math.round(Math.log2(wg));
  const C = wg * k;
  // Table slots (vec4), see ScanTables in scan-reference.ts.
  const AC = logWg;
  const POS0 = AC + 6;
  return /* wgsl */ `
const WG: u32 = ${wg}u;
const K: u32 = ${k}u;
const C: u32 = ${C}u;
const LOG_WG: u32 = ${logWg}u;
const T_AC: u32 = ${AC}u;
const T_ALAST: u32 = ${AC + 1}u;
const T_GFULL: u32 = ${AC + 2}u;
const T_GLAST: u32 = ${AC + 3}u;
const T_GAM: u32 = ${AC + 4}u;
const T_OSUM: u32 = ${AC + 5}u;
const T_POS0: u32 = ${POS0}u;
const T_POS1: u32 = ${POS0 + C}u;
const T_POS2: u32 = ${POS0 + 2 * C}u;

// Per-(cell, block) record in aux, REC floats.
const REC: u32 = 20u;
const R_PART: u32 = 0u;   // diff², x_k², dot
const R_CANDX: u32 = 3u;  // F (2), Σβx (2), Σδx (1) of x_{k+1} / peak
const R_CANDY: u32 = 8u;  // same for y_{k+1} / peak
const R_TR: u32 = 13u;    // Tr_b (2), Σ trace (1)
const R_SIN: u32 = 16u;   // forward carry-in state (2)
const R_QIN: u32 = 18u;   // reverse carry-in state (2)

struct Params {
  T: u32,
  nBlocks: u32,
  nCells: u32,
  filtered: u32,
  constraint: u32, // 0 = non-negative, 1 = box [0, 1]
  pad0: u32,
  pad1: u32,
  pad2: u32,
  d: f32,
  r: f32,
  invPeak: f32,
  step: f32,
  thresh: f32,
  tolSq: f32,
  invT: f32,
  pad3: f32,
};

struct Cell {
  t: f32,
  iter: u32,
  converged: u32,
  useX: u32, // 0 = momentum from x_{k-1}, 1 = y = x_k, 2 = y stored in the x_{k-1} slot
  baseline: f32,
  m: f32, // momentum used to form y from x_k, x_{k-1}
  iter0: u32, // iterations carried in by the warm start
  pad1: u32,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> trace: array<f32>;
// x_k lives in xa when the cell's iteration count is even, in xb when odd.
@group(0) @binding(2) var<storage, read_write> xa: array<f32>;
@group(0) @binding(3) var<storage, read_write> xb: array<f32>;
@group(0) @binding(4) var<storage, read_write> aux: array<f32>;
@group(0) @binding(5) var<storage, read> tab: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> cells: array<Cell>;

var<workgroup> sh: array<vec2<f32>, WG>;
var<workgroup> red0: array<vec4<f32>, WG>;
var<workgroup> red1: array<vec4<f32>, WG>;
var<workgroup> wgFlag: u32;

fn rec(cell: u32, b: u32) -> u32 { return (cell * P.nBlocks + b) * REC; }

fn tmat(slot: u32) -> mat2x2<f32> {
  let v = tab[slot];
  return mat2x2<f32>(v.xy, v.zw);
}

fn constrain(v: f32) -> f32 {
  if (P.constraint == 1u) { return clamp(v, 0.0, 1.0); }
  return max(v, 0.0);
}

// Workgroup-uniform "is this cell converged?" (thread 0 reads, all see it).
fn cellDone(cell: u32, tid: u32) -> bool {
  if (tid == 0u) { wgFlag = cells[cell].converged; }
  return workgroupUniformLoad(&wgFlag) != 0u;
}

// Tree-reduce two vec4 per thread; the totals end up in red0[0], red1[0].
fn reduce2(tid: u32, a: vec4<f32>, b: vec4<f32>) {
  red0[tid] = a;
  red1[tid] = b;
  workgroupBarrier();
  for (var s = WG / 2u; s > 0u; s = s >> 1u) {
    if (tid < s) {
      red0[tid] = red0[tid] + red0[tid + s];
      red1[tid] = red1[tid] + red1[tid + s];
    }
    workgroupBarrier();
  }
}

// Inclusive Hillis-Steele scan of the per-thread 2-state values; returns the
// state entering this thread (forward: from tid-1, or sIn for thread 0).
fn scanFwd(tid: u32, v: vec2<f32>, sIn: vec2<f32>) -> vec2<f32> {
  sh[tid] = v;
  workgroupBarrier();
  for (var i = 0u; i < LOG_WG; i++) {
    let o = 1u << i;
    var cur = sh[tid];
    if (tid >= o) { cur = cur + tmat(i) * sh[tid - o]; }
    workgroupBarrier();
    sh[tid] = cur;
    workgroupBarrier();
  }
  var ex = sIn;
  if (tid > 0u) { ex = sh[tid - 1u]; }
  workgroupBarrier();
  return ex;
}

// Reverse: returns the state entering this thread from tid+1 (qIn for the last).
fn scanRev(tid: u32, v: vec2<f32>, qIn: vec2<f32>) -> vec2<f32> {
  sh[tid] = v;
  workgroupBarrier();
  for (var i = 0u; i < LOG_WG; i++) {
    let o = 1u << i;
    var cur = sh[tid];
    if (tid + o < WG) { cur = cur + tmat(i) * sh[tid + o]; }
    workgroupBarrier();
    sh[tid] = cur;
    workgroupBarrier();
  }
  var ex = qIn;
  if (tid < WG - 1u) { ex = sh[tid + 1u]; }
  workgroupBarrier();
  return ex;
}

fn readX(odd: bool, i: u32) -> f32 {
  if (odd) { return xb[i]; }
  return xa[i];
}

fn writeX(odd: bool, i: u32, v: f32) {
  if (odd) { xb[i] = v; } else { xa[i] = v; }
}

// ---- load-time pass: trace terms and the x_0 candidate ----

@compute @workgroup_size(WG)
fn prep(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let cell = wid.y;
  let tid = lid.x;
  let base = cell * P.T;
  let last = b == P.nBlocks - 1u;
  var trAcc = vec4<f32>(0.0);
  var cand = vec4<f32>(0.0);
  var candD = vec4<f32>(0.0);
  // y_0 is x_0 (xa), or the stored y (xb) for a momentum warm start.
  let storedY = cells[cell].useX == 2u;
  for (var k = 0u; k < K; k++) {
    let p = tid * K + k;
    let t = b * C + p;
    if (t < P.T) {
      let tv = trace[base + t];
      let xv = readX(storedY, base + t) * P.invPeak;
      let w0 = tab[T_POS0 + p];
      let w1 = tab[T_POS1 + p];
      let w2 = tab[T_POS2 + p];
      trAcc = trAcc + vec4<f32>(w0.zw * tv, tv, 0.0);
      var beta = w1.xy;
      var delta = w2.x;
      if (last) { beta = w1.zw; delta = w2.y; }
      cand = cand + vec4<f32>(w0.xy * xv, beta * xv);
      candD.x = candD.x + delta * xv;
    }
  }
  reduce2(tid, trAcc, cand);
  let trS = red0[0];
  let cS = red1[0];
  workgroupBarrier();
  reduce2(tid, candD, vec4<f32>(0.0));
  if (tid == 0u) {
    let o = rec(cell, b);
    aux[o + R_TR] = trS.x;
    aux[o + R_TR + 1u] = trS.y;
    aux[o + R_TR + 2u] = trS.z;
    aux[o + R_CANDX] = cS.x;
    aux[o + R_CANDX + 1u] = cS.y;
    aux[o + R_CANDX + 2u] = cS.z;
    aux[o + R_CANDX + 3u] = cS.w;
    aux[o + R_CANDX + 4u] = red0[0].x;
  }
}

// ---- the fused iteration ----

${sweepEntry('sweep', false)}
// The first iteration after a load with momentum warm starts: y_0 is read
// from the x_{k-1} slot (useX = 2). A separate entry point so the per-sample
// loop of the regular sweep has no extra branch.
${sweepEntry('sweepFirst', true)}
// ---- per-cell passes ----

// Carries for the next iteration from the chosen candidate's functionals.
fn carryCell(cell: u32, st: Cell) -> f32 {
  var cand = R_CANDY;
  if (st.useX != 0u) { cand = R_CANDX; }
  let nb = P.nBlocks;
  let AC = tmat(T_AC);
  var s = vec2<f32>(0.0);
  var acc = 0.0;
  for (var b = 0u; b < nb; b++) {
    let o = rec(cell, b);
    aux[o + R_SIN] = s.x;
    aux[o + R_SIN + 1u] = s.y;
    if (P.filtered == 0u) {
      var gam = tab[T_GAM].xy;
      if (b == nb - 1u) { gam = tab[T_GAM].zw; }
      let cSum = (gam.x * s.x + gam.y * s.y) + aux[o + cand + 4u];
      acc = acc + (aux[o + R_TR + 2u] - cSum);
    }
    s = AC * s + vec2<f32>(aux[o + cand], aux[o + cand + 1u]);
  }
  var bl = 0.0;
  if (P.filtered == 0u) { bl = acc * P.invT; }
  var q = vec2<f32>(0.0);
  for (var j = nb; j > 0u; j--) {
    let b = j - 1u;
    let o = rec(cell, b);
    aux[o + R_QIN] = q.x;
    aux[o + R_QIN + 1u] = q.y;
    let lastB = b == nb - 1u;
    var G = tmat(T_GFULL);
    var O = tab[T_OSUM].xy;
    var A = AC;
    if (lastB) {
      G = tmat(T_GLAST);
      O = tab[T_OSUM].zw;
      A = tmat(T_ALAST);
    }
    let sIn = vec2<f32>(aux[o + R_SIN], aux[o + R_SIN + 1u]);
    let gs = G * sIn;
    let beta = vec2<f32>(aux[o + cand + 2u], aux[o + cand + 3u]);
    let tr = vec2<f32>(aux[o + R_TR], aux[o + R_TR + 1u]);
    let Q = P.invPeak * (((gs + beta) + bl * O) - tr);
    q = A * q + Q;
  }
  return bl;
}

@compute @workgroup_size(64)
fn carry(@builtin(global_invocation_id) gid: vec3<u32>) {
  let cell = gid.x;
  if (cell >= P.nCells) { return; }
  let st = cells[cell];
  if (st.converged != 0u) { return; }
  cells[cell].baseline = carryCell(cell, st);
}

@compute @workgroup_size(64)
fn fin(@builtin(global_invocation_id) gid: vec3<u32>) {
  let cell = gid.x;
  if (cell >= P.nCells) { return; }
  var st = cells[cell];
  if (st.converged != 0u) { return; }
  var diffSq = 0.0;
  var xkSq = 0.0;
  var dot = 0.0;
  for (var j = 0u; j < P.nBlocks; j++) {
    let o = rec(cell, j);
    diffSq = diffSq + aux[o + R_PART];
    xkSq = xkSq + aux[o + R_PART + 1u];
    dot = dot + aux[o + R_PART + 2u];
  }
  st.iter = st.iter + 1u;
  let tNew = (1.0 + sqrt(1.0 + 4.0 * st.t * st.t)) * 0.5;
  st.m = (st.t - 1.0) / tNew;
  let total = st.iter + st.iter0;
  if (total > 1u && dot > 0.0) {
    st.t = 1.0;
    st.useX = 1u;
  } else {
    st.t = tNew;
    st.useX = 0u;
  }
  if (total > 5u && diffSq < P.tolSq * (xkSq + 1e-20)) {
    st.converged = 1u;
  } else {
    st.baseline = carryCell(cell, st);
  }
  cells[cell] = st;
}
`;
}
