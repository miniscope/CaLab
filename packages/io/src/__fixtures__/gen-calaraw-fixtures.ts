// Writes the CALARAW1 fixtures that python/tests/test_calaraw.py decodes, so the
// browser encoder and the Python reader are checked against each other.
//
//   node packages/io/src/__fixtures__/gen-calaraw-fixtures.ts
//
// The frames follow the pattern in packages/io/src/__tests__/calaraw.test.ts.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calarawChunkName, encodeCalaraw, type CalarawMeta } from '../calaraw.ts';

const out = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../python/tests/fixtures/calaraw',
);

function pattern(m: CalarawMeta, t: number): Uint8Array | Uint16Array {
  const mask = m.bytesPerPixel === 1 ? 0xff : 0xffff;
  const f =
    m.bytesPerPixel === 1
      ? new Uint8Array(m.width * m.height)
      : new Uint16Array(m.width * m.height);
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) f[y * m.width + x] = (t * 40503 + y * 9973 + x * 7919) & mask;
  }
  return f;
}

const sets: Record<string, CalarawMeta> = {
  u16: { width: 5, height: 4, totalFrames: 7, bytesPerPixel: 2, predictor: 1, fps: 20 },
  u8: { width: 3, height: 6, totalFrames: 3, bytesPerPixel: 1, predictor: 0, fps: 30.5 },
};

for (const [name, m] of Object.entries(sets)) {
  const dir = resolve(out, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames = Array.from({ length: m.totalFrames }, (_, t) => pattern(m, t));
  // Two frames per chunk, so the u16 set has four chunks.
  const chunkBytes = 2 * m.width * m.height * m.bytesPerPixel;
  for await (const c of encodeCalaraw(m, frames, chunkBytes)) {
    writeFileSync(resolve(dir, calarawChunkName(c.index)), c.bytes);
  }
  console.log(`${name}: ${m.totalFrames} frames -> ${dir}`);
}
