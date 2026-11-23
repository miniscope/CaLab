#!/usr/bin/env node
/**
 * Local-only: size and speed of the data-donation codec (CALARAW1 + gzip,
 * packages/io/src/calaraw.ts) on real frames, with and without the predictor.
 *
 *   node apps/cala/scripts/donation-codec-bench.mjs <frames.raw> <width> <height> [--bpp 1|2] [--fps 20]
 *
 * `<frames.raw>` is raw row-major frames, e.g. from an AVI:
 *
 *   ffmpeg -i 0.avi -frames:v 300 -f rawvideo -pix_fmt gray frames.raw
 *
 * Node's CompressionStream is zlib at its default level; Chrome's compresses
 * ~5% smaller on the same input, so the ratios here are a lower bound for the
 * browser. Needs a Node that runs .ts imports (22.18+).
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { encodeCalaraw, decodeCalarawChunk } from '../../../packages/io/src/calaraw.ts';

const args = process.argv.slice(2);
const opt = (key, fallback) => {
  const i = args.indexOf(key);
  return i < 0 ? fallback : Number(args[i + 1]);
};
const [path, width, height] = [args[0], Number(args[1]), Number(args[2])];
if (!path || !width || !height) {
  console.error(
    'usage: donation-codec-bench.mjs <frames.raw> <width> <height> [--bpp 1|2] [--fps 20]',
  );
  process.exit(1);
}
const bpp = opt('--bpp', 1);
const fps = opt('--fps', 20);
const file = readFileSync(path);
const px = width * height;
const totalFrames = Math.floor(file.length / (px * bpp));
const frames = Array.from({ length: totalFrames }, (_, t) => {
  const bytes = new Uint8Array(
    file.buffer.slice(file.byteOffset + t * px * bpp, file.byteOffset + (t + 1) * px * bpp),
  );
  return bpp === 1 ? bytes : new Uint16Array(bytes.buffer);
});
const rawBytes = totalFrames * px * bpp;
const minutes = totalFrames / fps / 60;
console.log(
  `${path}: ${width}x${height}, ${bpp * 8}-bit, ${totalFrames} frames, ${(rawBytes / 1e6).toFixed(0)} MB`,
);

for (const predictor of [0, 1]) {
  const meta = { width, height, totalFrames, bytesPerPixel: bpp, predictor, fps };
  const t0 = performance.now();
  const chunks = [];
  for await (const c of encodeCalaraw(meta, frames)) chunks.push(c);
  const encodeS = (performance.now() - t0) / 1e3;
  const gz = chunks.reduce((n, c) => n + c.bytes.length, 0);
  const t1 = performance.now();
  for (const c of chunks) await decodeCalarawChunk(c.bytes);
  const decodeS = (performance.now() - t1) / 1e3;
  console.log(
    [
      `predictor ${predictor ? 'up  ' : 'none'}`,
      `${(rawBytes / gz).toFixed(2)}x`,
      `${(gz / 1e6 / minutes).toFixed(0)} MB per recorded minute`,
      `encode ${(rawBytes / 1e6 / encodeS).toFixed(0)} MB/s`,
      `decode ${(rawBytes / 1e6 / decodeS).toFixed(0)} MB/s`,
      `${chunks.length} chunk(s)`,
    ].join('  '),
  );
}
