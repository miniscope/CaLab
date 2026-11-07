#!/usr/bin/env node
/**
 * Local-only check of the cala frame source against a real Miniscope
 * recording. Not run in CI (it needs ~8 GB of data on disk).
 *
 *   node apps/cala/scripts/real-data-check.mjs [dir] [--python <python>] [--samples N]
 *        [--throughput N] [--motion N] [--batch N] [--motion-only] [--flicker-mode M]
 *
 * Opens the folder with the real `FrameSource` (the wasm AviHeader reading
 * only header prefixes, idx1 regions and single frames through lazily-read
 * file-backed Blobs), reads boundary and random frames, and hands their
 * SHA-256 digests to `verify_frames.py`, an independent reader that walks the
 * RIFF chunks itself and reads the pixels with numpy. Any disagreement fails.
 *
 * Then runs the app's preprocess + motion pipeline (`PipelineEngine`, the
 * same code the worker runs) headless over the first `--motion` frames
 * (default 300; 0 skips it) and prints rigid-shift and global-flicker
 * statistics and per-stage throughput (`--flicker-mode`: 0 off, 3 both, the
 * default; compare the preprocess ms/frame to time the flicker stage). `--motion-only` skips the frame checks and the Python reader.
 *
 * `--python` (or $CALA_PYTHON) must point at an interpreter with numpy, e.g.
 *   uv venv <dir> && uv pip install --python <dir>/bin/python numpy
 *
 * Needs Node >= 22.18 (type stripping, for the .ts imports). The dataset is
 * only ever read.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, openAsBlob, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const DEFAULT_DIR =
  '/Users/daharoni/Projects/workshop-processing-and-analysis/data/sessions/prerecorded/raw';

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const [, value] = args.splice(i, 2);
  return value ?? fallback;
}
const python = option('--python', process.env.CALA_PYTHON ?? 'python3');
const sampleCount = Number(option('--samples', '40'));
// Sequential batched-read throughput over this many frames from frame 0 (0 = skip).
const throughputFrames = Number(option('--throughput', '5000'));
// Frames run through the preprocess + motion pipeline (0 = skip).
const motionFrames = Number(option('--motion', '300'));
const motionBatch = Number(option('--batch', '8'));
const flickerModeArg = option('--flicker-mode', undefined);
const flickerMode = flickerModeArg === undefined ? undefined : Number(flickerModeArg);
function flag(name) {
  const on = args.includes(name);
  if (on) args.splice(args.indexOf(name), 1);
  return on;
}
const full = flag('--full');
const motionOnly = flag('--motion-only');
const dir = resolve(args[0] ?? DEFAULT_DIR);

const here = import.meta.dirname;
const { initCalaWasm } = await import(resolve(here, '../src/lib/cala-wasm.ts'));
const { FrameSource, entriesFromFiles, MAX_FRAMES_PER_READ } = await import(
  resolve(here, '../src/lib/frame-source.ts')
);
const { PipelineEngine } = await import(resolve(here, '../src/lib/pipeline-engine.ts'));
await initCalaWasm(readFileSync(resolve(here, '../../../crates/cala/pkg/calab_cala_bg.wasm')));

/** mulberry32: a seeded PRNG, so a failing sample list is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// File-backed Blobs: nothing is read until a slice is awaited.
const names = readdirSync(dir).filter((n) => /\.(avi|json|csv)$/i.test(n));
const files = await Promise.all(
  names.map(async (name) => new File([await openAsBlob(join(dir, name))], name)),
);

const rssBefore = process.memoryUsage().rss;
const t0 = performance.now();
const source = await FrameSource.open(entriesFromFiles(files));
const openMs = performance.now() - t0;
const info = source.info;
console.log(`opened ${dir}`);
console.log(
  `  ${info.files.length} files, ${info.frameCount} frames, ${info.width}x${info.height} ` +
    `${info.bitDepth}-bit ${info.fourcc}, bottomUp=${info.bottomUp}`,
);
console.log(
  `  fps=${info.fps?.toFixed(3)} (${info.fpsSource}); metadata=${info.fpsFromMetadata}, ` +
    `timestamps=${info.fpsFromTimestamps?.toFixed(3)}, AVI header declares ${info.aviDeclaredFps?.toFixed(1)} (ignored)`,
);
console.log(`  timestamp rows=${info.timestampCount}, warnings=${JSON.stringify(info.warnings)}`);
console.log(`  open took ${openMs.toFixed(0)} ms`);

/** Mean, SD, min, max of an array. */
function stats(xs) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  return `mean ${mean.toFixed(2)} sd ${sd.toFixed(2)} min ${Math.min(...xs).toFixed(2)} max ${Math.max(...xs).toFixed(2)}`;
}

// The app's preprocess + motion pipeline, headless, over the first frames.
if (motionFrames > 0) {
  const engine = new PipelineEngine(source, { batchSize: motionBatch }, flickerMode);
  const plan = engine.plan;
  const want = Math.min(motionFrames, plan.frameCount);
  console.log(
    `pipeline: calibration ${plan.calibrationFrames} frames, motion warm-up ${plan.motionWarmupFrames}, ` +
      `then ${want} frames in batches of ${plan.batchSize}`,
  );
  const dy = [];
  const dx = [];
  const quality = [];
  const flickerA = [];
  const flickerM = [];
  let anomalous = 0;
  const sum = { readMs: 0, preprocessMs: 0, motionMs: 0, otherMs: 0 };
  let peakRss = process.memoryUsage().rss;
  const tSetup = performance.now();
  let tProcess = 0;
  while (dy.length < want) {
    const r = await engine.step();
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (r.kind === 'done') break;
    if (r.kind === 'setup') continue;
    if (tProcess === 0) {
      tProcess =
        performance.now() -
        (r.timings.readMs + r.timings.preprocessMs + r.timings.motionMs + r.timings.otherMs);
      console.log(
        `  setup (calibration + template) took ${((tProcess - tSetup) / 1000).toFixed(2)} s`,
      );
    }
    for (const k of Object.keys(sum)) sum[k] += r.timings[k];
    for (let i = 0; i < r.count; i++) {
      dy.push(r.dy[i]);
      dx.push(r.dx[i]);
      quality.push(r.quality[i]);
      flickerA.push(r.flickerOffset[i]);
      flickerM.push(100 * r.flickerGain[i]);
      if (r.flags[i] & 2) anomalous++;
    }
  }
  const secs = (performance.now() - tProcess) / 1000;
  const n = dy.length;
  engine.dispose();
  const q = [...quality].sort((a, b) => a - b);
  console.log(`  dy (px): ${stats(dy)}`);
  console.log(`  dx (px): ${stats(dx)}`);
  console.log(`  flicker gain m (%): ${stats(flickerM)}`);
  console.log(`  flicker offset a (grey levels): ${stats(flickerA)}`);
  console.log(
    `  peak quality: median ${q[Math.floor(n / 2)].toFixed(3)}, p1 ${q[Math.floor(n / 100)].toFixed(3)}; ` +
      `anomalous frames ${anomalous}`,
  );
  const per = (ms) => (ms / n).toFixed(1);
  console.log(
    `  ${n} frames in ${secs.toFixed(2)} s = ${(n / secs).toFixed(1)} frames/s; ms/frame: ` +
      `read ${per(sum.readMs)}, preprocess ${per(sum.preprocessMs)}, motion ${per(sum.motionMs)}, ` +
      `previews ${per(sum.otherMs)}`,
  );
  console.log(`  peak RSS ${(peakRss / 1e6).toFixed(0)} MB`);
}
if (motionOnly) {
  source.dispose();
  process.exit(0);
}

// Boundaries (file edges, first and last frame) plus seeded random frames.
const framesPerFile = info.files[0].frames;
const indices = new Set([0, 1, framesPerFile - 1, framesPerFile, info.frameCount - 1]);
const rand = rng(20260507);
while (indices.size < sampleCount) indices.add(Math.floor(rand() * info.frameCount));
const sorted = [...indices].sort((a, b) => a - b);

const t1 = performance.now();
const samples = [];
for (const index of sorted) {
  const pixels = await source.readFrame(index);
  if (pixels.length !== info.width * info.height * (info.bitDepth / 8)) {
    throw new Error(`frame ${index}: ${pixels.length} bytes`);
  }
  samples.push({ index, sha256: createHash('sha256').update(pixels).digest('hex') });
}
const readMs = performance.now() - t1;
const rssGrowthMb = (process.memoryUsage().rss - rssBefore) / 1e6;
console.log(
  `  read ${samples.length} frames in ${readMs.toFixed(0)} ms ` +
    `(${(readMs / samples.length).toFixed(1)} ms/frame); RSS grew ${rssGrowthMb.toFixed(0)} MB ` +
    `(dataset is ${(info.files.length * 360).toFixed(0)} MB on disk)`,
);

// Sequential throughput, as the streaming preprocessing will read: batches of
// MAX_FRAMES_PER_READ into one reused buffer (so no allocation per batch).
const span = full ? info.frameCount : Math.min(throughputFrames, info.frameCount);
if (span > 0) {
  const px = info.width * info.height;
  const Pixels = info.bitDepth === 16 ? Uint16Array : Uint8Array;
  const out = new Pixels(px * MAX_FRAMES_PER_READ);
  const t2 = performance.now();
  let checksum = 0;
  for (let at = 0; at < span; at += MAX_FRAMES_PER_READ) {
    const n = Math.min(MAX_FRAMES_PER_READ, span - at);
    const buf = n === MAX_FRAMES_PER_READ ? out : new Pixels(px * n);
    await source.readFrames(at, n, buf);
    checksum = (checksum + buf[0] + buf[buf.length - 1]) % 1e9;
  }
  const secs = (performance.now() - t2) / 1000;
  const mb = (span * px * (info.bitDepth / 8)) / 1e6;
  console.log(
    `  sequential batched read: ${span} frames in ${secs.toFixed(2)} s = ${(span / secs).toFixed(0)} frames/s, ` +
      `${(mb / secs).toFixed(0)} MB/s (checksum ${checksum})`,
  );
}

const work = mkdtempSync(join(tmpdir(), 'cala-real-'));
const jsonPath = join(work, 'samples.json');
writeFileSync(
  jsonPath,
  JSON.stringify({
    dir,
    files: info.files,
    width: info.width,
    height: info.height,
    bitDepth: info.bitDepth,
    samples,
  }),
);
const res = spawnSync(python, ['-I', resolve(here, 'verify_frames.py'), jsonPath], {
  stdio: 'inherit',
});
source.dispose();
if (res.status !== 0) {
  console.error('FAILED: the independent reader disagrees (or could not run).');
  process.exit(res.status ?? 1);
}
console.log('real-data check passed');
