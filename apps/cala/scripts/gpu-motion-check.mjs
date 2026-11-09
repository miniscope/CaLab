#!/usr/bin/env node
/**
 * GPU vs CPU motion correction, in a real browser (WebGPU is not available in
 * the Node test runner). Local check, not run in CI.
 *
 *   npm run dev -w cala -- --port 5194      # in one terminal
 *   node apps/cala/scripts/gpu-motion-check.mjs [url] [--frames N] [--size S]
 *
 * Builds two identical `MotionCorrector`s on a synthetic recording (smooth
 * cell-like texture, random-walk motion with sub-pixel positions, shot-like
 * noise), streams the same frames through the WASM path and through the GPU
 * path (`GpuMotion` prefilter + `estimateF32Prefiltered` + GPU warp) and
 * prints the differences: shifts in px, corrected pixels relative to the
 * noise level, and the quality / flag agreement. Exits non-zero when a
 * shift differs by more than 0.05 px.
 *
 * Chromium needs `--enable-unsafe-webgpu --use-angle=metal` (macOS headless).
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  return args.splice(i, 2)[1] ?? fallback;
}
const frames = Number(option('--frames', '96'));
const size = Number(option('--size', '600'));
const url = args[0] ?? 'http://localhost:5194/';

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=metal'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('page error:', e.message));
await page.goto(url);
const result = await page.evaluate(
  async ({ frames, size }) => {
    const wasm = await import('/src/lib/cala-wasm.ts');
    const { GpuMotion } = await import('/src/lib/gpu-motion.ts');
    await wasm.initCalaWasm();
    const W = size;
    const H = size;
    const px = W * H;
    const BATCH = 8;
    // Deterministic RNG.
    let seed = 12345;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const blobs = Array.from({ length: Math.round(W / 2) }, () => ({
      y: rnd() * H,
      x: rnd() * W,
      s: 3 + rnd() * 5,
      a: 40 + rnd() * 120,
    }));
    const NOISE = 6;
    function render(sy, sx) {
      const f = new Float32Array(px);
      for (let i = 0; i < px; i++) f[i] = 200 + NOISE * gauss();
      for (const b of blobs) {
        const r = Math.ceil(b.s * 3.5);
        const cy = b.y + sy;
        const cx = b.x + sx;
        for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, cy + r); y++)
          for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, cx + r); x++) {
            const d2 = (y - cy) ** 2 + (x - cx) ** 2;
            f[y * W + x] += b.a * Math.exp(-d2 / (2 * b.s * b.s));
          }
      }
      return f;
    }
    function makeCorrector() {
      const o = new wasm.MotionOptions();
      const m = new wasm.MotionCorrector(W, H, o);
      o.free();
      m.setFovMask(new Uint8Array(px).fill(1));
      return m;
    }
    const cpu = makeCorrector();
    const gpuC = makeCorrector();
    const warm = [];
    for (let i = 0; i < 24; i++) warm.push(render(0, 0));
    for (const m of [cpu, gpuC]) {
      m.warmupBegin();
      for (let i = 0; i < warm.length; i += BATCH) {
        const b = new Float32Array(BATCH * px);
        warm.slice(i, i + BATCH).forEach((f, j) => b.set(f, j * px));
        m.warmupPushF32(b);
      }
      m.warmupFinish();
    }
    const gpu = await GpuMotion.create(W, H, BATCH);
    if (!gpu) return { error: 'WebGPU is not available' };
    if (!gpu.setup(gpuC.prefilterParams())) return { error: 'GPU setup refused the settings' };
    const geo = gpuC.prefilterParams();
    const fpx = geo[2] * geo[3];
    const rl = cpu.recordLen;

    let py = 0;
    let px_ = 0;
    const dShift = [];
    const dQuality = [];
    let flagMismatch = 0;
    let maxPix = 0;
    let sumPix = 0;
    let nPix = 0;
    let maxRel = 0;
    let msCpu = 0;
    let msGpuEst = 0;
    for (let i = 0; i < frames; i += BATCH) {
      const n = Math.min(BATCH, frames - i);
      const batch = new Float32Array(n * px);
      for (let j = 0; j < n; j++) {
        py = Math.max(-6, Math.min(6, py + 0.6 * gauss()));
        px_ = Math.max(-6, Math.min(6, px_ + 0.6 * gauss()));
        batch.set(render(py, px_), j * px);
      }
      const outC = new Float32Array(n * px);
      const recC = new Float32Array(n * rl);
      let t = performance.now();
      cpu.processF32(batch, outC, recC);
      msCpu += performance.now() - t;
      t = performance.now();
      const filtered = new Float32Array(n * fpx);
      const { slot } = await gpu.prefilter(batch, n, filtered);
      const recG = new Float32Array(n * rl);
      gpuC.estimateF32Prefiltered(batch, filtered, recG);
      msGpuEst += performance.now() - t;
      const dy = new Float32Array(n);
      const dx = new Float32Array(n);
      for (let j = 0; j < n; j++) {
        dy[j] = recG[j * rl];
        dx[j] = recG[j * rl + 1];
      }
      const outG = new Float32Array(n * px);
      await gpu.warp(slot, dy, dx, n, outG);
      for (let j = 0; j < n; j++) {
        dShift.push(Math.hypot(recC[j * rl] - recG[j * rl], recC[j * rl + 1] - recG[j * rl + 1]));
        dQuality.push(Math.abs(recC[j * rl + 2] - recG[j * rl + 2]));
        if (recC[j * rl + 3] !== recG[j * rl + 3]) flagMismatch++;
      }
      // Pixel agreement of the warp when both use the SAME shift (isolates the
      // warp) and as the pipeline runs (each path with its own shift).
      for (let k = 0; k < n * px; k++) {
        const d = Math.abs(outC[k] - outG[k]);
        if (d > maxPix) maxPix = d;
        sumPix += d;
        nPix++;
      }
    }
    // Warp alone, identical shifts: replay the CPU records on the GPU.
    const n = BATCH;
    const batch = new Float32Array(n * px);
    for (let j = 0; j < n; j++) batch.set(render(1.37 * j - 4.2, -0.81 * j + 3.3), j * px);
    const rec = new Float32Array(n * rl);
    for (let j = 0; j < n; j++) {
      rec[j * rl] = 1.37 * j - 4.2;
      rec[j * rl + 1] = -0.81 * j + 3.3;
    }
    const outA = new Float32Array(n * px);
    cpu.applyF32(batch, rec, outA);
    const { slot } = await gpu.prefilter(batch, n, new Float32Array(n * fpx));
    const outB = new Float32Array(n * px);
    await gpu.warp(
      slot,
      Float32Array.from({ length: n }, (_, j) => rec[j * rl]),
      Float32Array.from({ length: n }, (_, j) => rec[j * rl + 1]),
      n,
      outB,
    );
    let warpMax = 0;
    for (let k = 0; k < n * px; k++) warpMax = Math.max(warpMax, Math.abs(outA[k] - outB[k]));
    const stats = (a) => {
      const s = [...a].sort((x, y) => x - y);
      return {
        max: s[s.length - 1],
        mean: s.reduce((p, v) => p + v, 0) / s.length,
        p99: s[Math.floor(0.99 * (s.length - 1))],
      };
    };
    return {
      frames,
      size: W,
      noiseSigma: NOISE,
      shift: stats(dShift),
      quality: stats(dQuality),
      flagMismatch,
      pixel: { max: maxPix, mean: sumPix / nPix, maxOverNoise: maxPix / NOISE },
      warpOnlyMax: warpMax,
      warpOnlyMaxOverNoise: warpMax / NOISE,
      msPerFrameCpuAll: msCpu / frames,
      msPerFrameGpuEstimate: msGpuEst / frames,
      maxRel,
    };
  },
  { frames, size },
);
console.log(JSON.stringify(result, null, 2));
await browser.close();
if (result.error || result.shift.max > 0.05) process.exit(1);
