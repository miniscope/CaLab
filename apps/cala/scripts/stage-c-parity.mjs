/** Fused/unfused WASM regression, including explicit memory growth between batches. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import init, {
  resolveParams,
  PreprocessWarmup,
  Preprocessor,
  TraceLibraryBuilder,
  TraceEngine,
  QcMonitor,
} from '../../../crates/cala/pkg/calab_cala.js';
const wasm = await init({
  module_or_path: readFileSync(
    new URL('../../../crates/cala/pkg/calab_cala_bg.wasm', import.meta.url),
  ),
});
const W = 64,
  H = 48,
  N = W * H,
  B = 8;
const raw = Uint8Array.from({ length: N * 24 }, (_, i) => {
  const p = i % N,
    y = Math.floor(p / W),
    x = p % W;
  return (y - 24) ** 2 + (x - 32) ** 2 < 22 ** 2 ? 100 + ((i * 7) % 40) : 2;
});
// The default params at 20 fps.
const params = resolveParams('{}', JSON.stringify({ fps: 20, frame: [W, H] }));
const warm = new PreprocessWarmup(W, H, params);
warm.pushFrames(raw, 24);
const seed = warm.finish(),
  state = seed.state();
const builder = new TraceLibraryBuilder(W, H);
for (let c = 0; c < 3; c++)
  builder.addFootprint(
    c + 1,
    20 + c * 3,
    15 + c * 4,
    9,
    9,
    Float32Array.from({ length: 81 }, (_, p) =>
      Math.exp(-(((p % 9) - 4) ** 2 + (Math.floor(p / 9) - 4) ** 2) / 6),
    ),
  );
const lib = builder.buildUnfiltered();
let batches = 0;
for (const withQc of [false, true]) {
  const a = Preprocessor.fromState(state),
    b = Preprocessor.fromState(state);
  const ea = new TraceEngine(lib, params),
    eb = new TraceEngine(lib, params);
  ea.setSigned(true);
  eb.setSigned(true);
  const qa = withQc ? new QcMonitor(W, H, a.fovMask(), a.noiseSigma(), params) : null;
  const qb = withQc ? new QcMonitor(W, H, b.fovMask(), b.noiseSigma(), params) : null;
  for (let j = 0; j < 30; j++) {
    const count = j === 29 ? 3 : B;
    const x = Float32Array.from(
      { length: N * count },
      (_, i) => 30 + Math.sin(i * 0.01 + j) * 5 + (i % 17),
    );
    const y = x.slice();
    const dy = Float32Array.from({ length: count }, (_, i) => (i % 3) - 1),
      dx = Float32Array.from({ length: count }, (_, i) => i % 2);
    const refresh = j % 3 === 0;
    a.backFramesRegistered(x, count, dy, dx);
    if (refresh && qa) qa.setNoise(a.noiseSigma());
    const ta = qa ? qa.processFramesShifted(ea, x, count, dy, dx) : ea.processFrames(x, count);
    const prior = wasm.memory.buffer;
    wasm.memory.grow(1);
    assert.equal(prior.byteLength, 0);
    const tb = qb
      ? b.backTraceQcFramesRegistered(eb, qb, y, count, dy, dx, refresh)
      : b.backTraceFramesRegistered(eb, y, count, dy, dx);
    assert.deepEqual(y, x);
    assert.deepEqual(tb, ta);
    assert.deepEqual(b.noiseSigma(), a.noiseSigma());
    assert.deepEqual(eb.lastSigned(), ea.lastSigned());
    assert.deepEqual(eb.lastBackground(), ea.lastBackground());
    if (qa) {
      assert.deepEqual(qb.cellMetrics(), qa.cellMetrics());
      assert.deepEqual(qb.globalMetrics(), qa.globalMetrics());
      assert.deepEqual(qb.residualMap(), qa.residualMap());
    }
    batches++;
  }
  qa?.free();
  qb?.free();
  ea.free();
  eb.free();
  a.free();
  b.free();
}
seed.free();
params.free();
lib.free();
console.log(
  `${batches} fused/unfused batches identical, with and without QC, signed/background outputs, partial batches, and forced memory.grow`,
);
