/**
 * WGSL for one batched banded-AR(2) FISTA iteration. Kept as a template
 * string so Vite and Vitest import it without plugins.
 *
 * Layout: cell-major flat buffers, index = cell * T + t. A "block" is
 * C = WG * K consecutive samples owned by one workgroup; block-level entry
 * points are dispatched as (nBlocks, nCells), per-cell ones as
 * ceil(nCells / 64). Every entry point returns early for converged cells.
 *
 * Per iteration (see gpu-fista.ts for the encode order):
 *   fwd1    local scan of IIR(d) over x[t] = src[t-1] / peak     -> s1, ends_d
 *   carryD  per-cell carry propagation over blocks              (ends_d -> carry_d)
 *   fwd2    fix-up IIR(d) + local scan of IIR(r)                 -> s2, ends_r
 *   carryR
 *   [fwd3   unfiltered only: fix-up IIR(r) in place, partial sum(trace - c)]
 *   [bfin   unfiltered only: per-cell baseline = sum / T]
 *   adj1    residual on the fly + reverse local scan of IIR(d)   -> s1, ends_d
 *   carryD
 *   adj2    fix-up + reverse local scan of IIR(r)                -> s2, ends_r
 *   carryR
 *   prox    gradient fix-up with the one-sample shift, prox step, momentum,
 *           partial reductions (diff^2, x_old^2, dot) per block
 *   fin     per-cell: iteration++, t_fista, adaptive restart, convergence
 *
 * Restart: instead of copying y = x, `fin` sets the cell's useX flag and the
 * next iteration reads x wherever it would read y (fwd1 source, prox y).
 */
export function fistaShaderSource(wg: number, k: number): string {
  return /* wgsl */ `
const WG: u32 = ${wg}u;
const K: u32 = ${k}u;
const C: u32 = ${wg * k}u;
const R_OFF: u32 = ${wg * k + 1}u; // offset of the r^j table in pows

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
  dC: f32,
  rC: f32,
  pad3: f32,
  pad4: f32,
  pad5: f32,
};

struct Cell {
  t: f32,
  iter: u32,
  converged: u32,
  useX: u32,
  baseline: f32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> trace: array<f32>;
@group(0) @binding(2) var<storage, read_write> xs: array<f32>;
@group(0) @binding(3) var<storage, read_write> ys: array<f32>;
@group(0) @binding(4) var<storage, read_write> s1: array<f32>;
@group(0) @binding(5) var<storage, read_write> s2: array<f32>;
// aux: [ends/carries d: nCells*nBlocks][ends/carries r: nCells*nBlocks][partials: nCells*nBlocks*4]
@group(0) @binding(6) var<storage, read_write> aux: array<f32>;
// pows: [d^0 .. d^C][r^0 .. r^C]
@group(0) @binding(7) var<storage, read> pows: array<f32>;
@group(0) @binding(8) var<storage, read_write> cells: array<Cell>;

var<workgroup> sh: array<f32, WG>;
var<workgroup> red: array<vec4<f32>, WG>;
var<workgroup> wgFlag: u32;
var<private> vals: array<f32, K>;

fn cdIdx(cell: u32, b: u32) -> u32 { return cell * P.nBlocks + b; }
fn crIdx(cell: u32, b: u32) -> u32 { return (P.nCells + cell) * P.nBlocks + b; }
fn partIdx(cell: u32, b: u32, j: u32) -> u32 {
  return 2u * P.nCells * P.nBlocks + (cell * P.nBlocks + b) * 4u + j;
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

// Block-local scan of v[l] = a * v[l-1] + vals over this workgroup's block.
// On entry vals holds this thread's K inputs; on exit the block-local outputs
// (zero carry-in at the block start). Returns the block end value.
fn blockScan(tid: u32, a: f32, powOff: u32) -> f32 {
  var acc = 0.0;
  for (var k = 0u; k < K; k++) {
    acc = a * acc + vals[k];
    vals[k] = acc;
  }
  sh[tid] = acc;
  workgroupBarrier();
  for (var o = 1u; o < WG; o = o << 1u) {
    var v = sh[tid];
    if (tid >= o) { v = v + pows[powOff + K * o] * sh[tid - o]; }
    workgroupBarrier();
    sh[tid] = v;
    workgroupBarrier();
  }
  var carry = 0.0;
  if (tid > 0u) { carry = sh[tid - 1u]; }
  for (var k = 0u; k < K; k++) {
    vals[k] = vals[k] + pows[powOff + k + 1u] * carry;
  }
  let end = sh[WG - 1u];
  workgroupBarrier();
  return end;
}

fn reduce4(tid: u32, v: vec4<f32>) -> vec4<f32> {
  red[tid] = v;
  workgroupBarrier();
  for (var s = WG / 2u; s > 0u; s = s >> 1u) {
    if (tid < s) { red[tid] = red[tid] + red[tid + s]; }
    workgroupBarrier();
  }
  return red[0];
}

// Fully fixed-up value of a forward-order IIR(r) result at physical t.
fn fwdR(cell: u32, t: u32) -> f32 {
  let b = t / C;
  return s2[cell * P.T + t] + pows[R_OFF + (t - b * C) + 1u] * aux[crIdx(cell, b)];
}

// Fully fixed-up value of the reverse-order IIR(r) result at physical t.
fn revR(cell: u32, t: u32) -> f32 {
  let l = P.T - 1u - t;
  let b = l / C;
  return s2[cell * P.T + t] + pows[R_OFF + (l - b * C) + 1u] * aux[crIdx(cell, b)];
}

// ---- forward convolution ----

@compute @workgroup_size(WG)
fn fwd1(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let cell = wid.y;
  let tid = lid.x;
  if (cellDone(cell, tid)) { return; }
  let base = cell * P.T;
  let useX = cells[cell].useX != 0u;
  for (var k = 0u; k < K; k++) {
    let l = b * C + tid * K + k;
    var v = 0.0;
    if (l >= 1u && l < P.T) {
      var src = ys[base + l - 1u];
      if (useX) { src = xs[base + l - 1u]; }
      v = src * P.invPeak;
    }
    vals[k] = v;
  }
  let end = blockScan(tid, P.d, 0u);
  for (var k = 0u; k < K; k++) {
    let l = b * C + tid * K + k;
    if (l < P.T) { s1[base + l] = vals[k]; }
  }
  if (tid == 0u) { aux[cdIdx(cell, b)] = end; }
}

@compute @workgroup_size(WG)
fn fwd2(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let cell = wid.y;
  let tid = lid.x;
  if (cellDone(cell, tid)) { return; }
  let base = cell * P.T;
  let carry = aux[cdIdx(cell, b)];
  for (var k = 0u; k < K; k++) {
    let p = tid * K + k;
    let l = b * C + p;
    var v = 0.0;
    if (l < P.T) { v = s1[base + l] + pows[p + 1u] * carry; }
    vals[k] = v;
  }
  let end = blockScan(tid, P.r, R_OFF);
  for (var k = 0u; k < K; k++) {
    let l = b * C + tid * K + k;
    if (l < P.T) { s2[base + l] = vals[k]; }
  }
  if (tid == 0u) { aux[crIdx(cell, b)] = end; }
}

// Unfiltered only: finish the reconvolution in place and sum (trace - c).
@compute @workgroup_size(WG)
fn fwd3(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let cell = wid.y;
  let tid = lid.x;
  if (cellDone(cell, tid)) { return; }
  let base = cell * P.T;
  var acc = 0.0;
  for (var k = 0u; k < K; k++) {
    let t = b * C + tid * K + k;
    if (t < P.T) {
      let c = fwdR(cell, t);
      s2[base + t] = c;
      acc = acc + (trace[base + t] - c);
    }
  }
  let s = reduce4(tid, vec4<f32>(acc, 0.0, 0.0, 0.0));
  if (tid == 0u) { aux[partIdx(cell, b, 3u)] = s.x; }
}

@compute @workgroup_size(64)
fn bfin(@builtin(global_invocation_id) gid: vec3<u32>) {
  let cell = gid.x;
  if (cell >= P.nCells) { return; }
  if (cells[cell].converged != 0u) { return; }
  var s = 0.0;
  for (var j = 0u; j < P.nBlocks; j++) { s = s + aux[partIdx(cell, j, 3u)]; }
  cells[cell].baseline = s * P.invT;
}

// ---- per-cell carry propagation ----

fn carryPass(off: u32, aC: f32) {
  var carry = 0.0;
  for (var j = 0u; j < P.nBlocks; j++) {
    let e = aux[off + j];
    aux[off + j] = carry;
    carry = aC * carry + e;
  }
}

@compute @workgroup_size(64)
fn carryD(@builtin(global_invocation_id) gid: vec3<u32>) {
  let cell = gid.x;
  if (cell >= P.nCells) { return; }
  if (cells[cell].converged != 0u) { return; }
  carryPass(cdIdx(cell, 0u), P.dC);
}

@compute @workgroup_size(64)
fn carryR(@builtin(global_invocation_id) gid: vec3<u32>) {
  let cell = gid.x;
  if (cell >= P.nCells) { return; }
  if (cells[cell].converged != 0u) { return; }
  carryPass(crIdx(cell, 0u), P.rC);
}

// ---- adjoint convolution (reverse logical index l = T-1-t) ----

@compute @workgroup_size(WG)
fn adj1(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let cell = wid.y;
  let tid = lid.x;
  if (cellDone(cell, tid)) { return; }
  let base = cell * P.T;
  let filtered = P.filtered != 0u;
  var bl = 0.0;
  if (!filtered) { bl = cells[cell].baseline; }
  for (var k = 0u; k < K; k++) {
    let l = b * C + tid * K + k;
    var v = 0.0;
    if (l < P.T) {
      let t = P.T - 1u - l;
      var c = s2[base + t];
      if (filtered) { c = fwdR(cell, t); }
      v = ((c + bl) - trace[base + t]) * P.invPeak;
    }
    vals[k] = v;
  }
  let end = blockScan(tid, P.d, 0u);
  for (var k = 0u; k < K; k++) {
    let l = b * C + tid * K + k;
    if (l < P.T) { s1[base + P.T - 1u - l] = vals[k]; }
  }
  if (tid == 0u) { aux[cdIdx(cell, b)] = end; }
}

@compute @workgroup_size(WG)
fn adj2(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let cell = wid.y;
  let tid = lid.x;
  if (cellDone(cell, tid)) { return; }
  let base = cell * P.T;
  let carry = aux[cdIdx(cell, b)];
  for (var k = 0u; k < K; k++) {
    let p = tid * K + k;
    let l = b * C + p;
    var v = 0.0;
    if (l < P.T) { v = s1[base + P.T - 1u - l] + pows[p + 1u] * carry; }
    vals[k] = v;
  }
  let end = blockScan(tid, P.r, R_OFF);
  for (var k = 0u; k < K; k++) {
    let l = b * C + tid * K + k;
    if (l < P.T) { s2[base + P.T - 1u - l] = vals[k]; }
  }
  if (tid == 0u) { aux[crIdx(cell, b)] = end; }
}

// ---- prox step + momentum + partial reductions (physical order) ----

@compute @workgroup_size(WG)
fn prox(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let b = wid.x;
  let cell = wid.y;
  let tid = lid.x;
  if (cellDone(cell, tid)) { return; }
  let base = cell * P.T;
  let st = cells[cell];
  let useX = st.useX != 0u;
  let tNew = (1.0 + sqrt(1.0 + 4.0 * st.t * st.t)) * 0.5;
  let m = (st.t - 1.0) / tNew;
  var acc = vec4<f32>(0.0);
  for (var k = 0u; k < K; k++) {
    let i = b * C + tid * K + k;
    if (i < P.T) {
      // gradient[i] = a[i+1] (adjoint one-sample advance), gradient[T-1] = 0
      var g = 0.0;
      if (i + 1u < P.T) { g = revR(cell, i + 1u); }
      let xo = xs[base + i];
      var yv = ys[base + i];
      if (useX) { yv = xo; }
      let z = yv - P.step * g;
      let xn = constrain(z - P.thresh);
      xs[base + i] = xn;
      ys[base + i] = constrain(xn + m * (xn - xo));
      let dd = xn - xo;
      acc = acc + vec4<f32>(dd * dd, xo * xo, (yv - xn) * dd, 0.0);
    }
  }
  let s = reduce4(tid, acc);
  if (tid == 0u) {
    aux[partIdx(cell, b, 0u)] = s.x;
    aux[partIdx(cell, b, 1u)] = s.y;
    aux[partIdx(cell, b, 2u)] = s.z;
  }
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
    diffSq = diffSq + aux[partIdx(cell, j, 0u)];
    xkSq = xkSq + aux[partIdx(cell, j, 1u)];
    dot = dot + aux[partIdx(cell, j, 2u)];
  }
  st.iter = st.iter + 1u;
  let tNew = (1.0 + sqrt(1.0 + 4.0 * st.t * st.t)) * 0.5;
  if (st.iter > 1u && dot > 0.0) {
    st.t = 1.0;
    st.useX = 1u;
  } else {
    st.t = tNew;
    st.useX = 0u;
  }
  if (st.iter > 5u && diffSq < P.tolSq * (xkSq + 1e-20)) {
    st.converged = 1u;
  }
  cells[cell] = st;
}
`;
}
