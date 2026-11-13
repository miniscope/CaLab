#!/usr/bin/env node
/**
 * Local-only timing of the WASM tile compressor on one dumped window.
 *
 *   node apps/cala/scripts/compress-bench.mjs <window.i16> [--tile N] [--frames N] [--pkg DIR]
 *
 * `<window.i16>` comes from `discover_eval --compress-dump` (crates/cala);
 * `crates/cala/examples/compress_bench.rs` times the native build on the same
 * file. Node runs WASM in V8, the engine of Chrome, on one thread, so this is
 * the cost a compress worker would see. Needs `crates/cala/pkg` (`npm run
 * build:wasm`), or another wasm-pack output directory with `--pkg`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const text = (key, fallback) => {
  const i = args.indexOf(key);
  return i < 0 ? fallback : args[i + 1];
};
const value = (key, fallback) => Number(text(key, fallback));

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(text('--pkg', resolve(here, '../../../crates/cala/pkg')));
const { default: init, TileCompressor } = await import(resolve(pkg, 'calab_cala.js'));
await init({ module_or_path: readFileSync(resolve(pkg, 'calab_cala_bg.wasm')) });
const file = readFileSync(args[0]);
if (file.subarray(0, 8).toString('latin1') !== 'CALAWIN1') throw new Error('not a window dump');
const head = new DataView(file.buffer, file.byteOffset, 24);
const width = head.getUint32(8, true);
const height = head.getUint32(12, true);
const stored = head.getUint32(16, true);
const quant = head.getFloat32(20, true);
const frames = Math.min(value('--frames', stored), stored);
const tile = value('--tile', 64);
const px = width * height;
// Copy out of the file buffer so the Int16Array is aligned.
const data = new Int16Array(
  file.buffer.slice(file.byteOffset + 24, file.byteOffset + 24 + frames * px * 2),
);

const compressor = new TileCompressor(quant);
let ms = 0;
let rank = 0;
let svdRank = 0;
let tiles = 0;
let bytes = 0;
for (let y0 = 0; y0 < height; y0 += tile) {
  for (let x0 = 0; x0 < width; x0 += tile) {
    const w = Math.min(tile, width - x0);
    const h = Math.min(tile, height - y0);
    const raw = new Int16Array(frames * w * h);
    let o = 0;
    for (let t = 0; t < frames; t++) {
      for (let y = 0; y < h; y++) {
        const row = t * px + (y0 + y) * width + x0;
        raw.set(data.subarray(row, row + w), o);
        o += w;
      }
    }
    const t0 = performance.now();
    const f = compressor.compress(raw, frames, x0, y0, w, h, tiles);
    ms += performance.now() - t0;
    rank += f.rank;
    svdRank += f.svdRank;
    bytes += 4 * (f.rank * (w * h + frames) + w * h);
    f.free();
    tiles++;
  }
}
console.log(
  `wasm (V8 ${process.versions.v8}): ${width}x${height}, ${frames} frames, ${tiles} tiles: ` +
    `${(ms / frames).toFixed(2)} ms/frame, mean rank ${(rank / tiles).toFixed(1)}, ` +
    `svd rank ${(svdRank / tiles).toFixed(1)}, ${(bytes / frames).toFixed(0)} bytes/frame`,
);
