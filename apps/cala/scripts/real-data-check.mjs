#!/usr/bin/env node
/**
 * Local-only check of the cala frame source against a real Miniscope
 * recording. Not run in CI (it needs ~8 GB of data on disk).
 *
 *   node apps/cala/scripts/real-data-check.mjs [dir] [--python <python>] [--samples N]
 *
 * Opens the folder with the real `FrameSource` (the wasm AviHeader reading
 * only header prefixes, idx1 regions and single frames through lazily-read
 * file-backed Blobs), reads boundary and random frames, and hands their
 * SHA-256 digests to `verify_frames.py`, an independent reader that walks the
 * RIFF chunks itself and reads the pixels with numpy. Any disagreement fails.
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
const dir = resolve(args[0] ?? DEFAULT_DIR);

const here = import.meta.dirname;
const { initCalaWasm } = await import(resolve(here, '../src/lib/cala-wasm.ts'));
const { FrameSource } = await import(resolve(here, '../src/lib/frame-source.ts'));
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
const source = await FrameSource.open(files);
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
