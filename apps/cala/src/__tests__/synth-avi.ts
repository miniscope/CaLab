/** Synthetic plain-RIFF AVI builder for tests (mirrors the Rust test builder). */

export type IdxMode = 'none' | 'relative' | 'absolute';

export interface SynthOptions {
  width: number;
  /** Signed `biHeight`: positive = bottom-up (what real Miniscope files have). */
  height: number;
  frames: number;
  /** `biCompression` text; '' = BI_RGB. */
  fourcc?: string;
  bitCount?: number;
  idx?: IdxMode;
  /** Declared microseconds per frame in avih (default 16666 = a bogus "60 fps"). */
  usec?: number;
  /** Added to frame numbers so that files of one recording differ in content. */
  frameOffset?: number;
  /** `dwTotalFrames` written to avih (default: the real count). */
  avihFrames?: number;
  /** Write 0 as the movi LIST size, as a writer that crashed before close leaves it. */
  zeroMoviSize?: boolean;
  /** A JUNK chunk before the first frame inside movi (no fixed stride then). */
  junkInMovi?: boolean;
  /** The frame payloads, padded rows (default: the `pixelAt` ramp). */
  payload?: (f: number) => Uint8Array;
}

const enc = new TextEncoder();

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function chunk(id: string, body: Uint8Array): Uint8Array {
  return concat(
    enc.encode(id),
    u32(body.length),
    body,
    body.length % 2 ? new Uint8Array(1) : new Uint8Array(0),
  );
}

function list(kind: string, body: Uint8Array): Uint8Array {
  return chunk('LIST', concat(enc.encode(kind), body));
}

export function rowStride(width: number, bitCount: number): number {
  return Math.ceil((width * bitCount) / 32) * 4;
}

/** Expected pixel value (stored row r, column x) of frame f; padding bytes are 0xEE. */
export function pixelAt(f: number, r: number, x: number): number {
  return (f * 31 + r * 7 + x) % 251;
}

/** The padded chunk payload of frame `f` (8-bit). */
export function framePayload(o: SynthOptions, f: number): Uint8Array {
  const bits = o.bitCount ?? 8;
  const stride = rowStride(o.width, bits);
  const rows = Math.abs(o.height);
  const out = new Uint8Array(stride * rows).fill(0xee);
  const bpp = bits / 8;
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < o.width; x++) {
      for (let b = 0; b < bpp; b++) {
        out[r * stride + x * bpp + b] = (pixelAt(f, r, x) + b * 100) % 251;
      }
    }
  }
  return out;
}

/** The unpadded pixels a decoder should return for frame `f` (stored row order). */
export function expectedPixels(o: SynthOptions, f: number): Uint8Array {
  const bits = o.bitCount ?? 8;
  const stride = rowStride(o.width, bits);
  const rowBytes = o.width * (bits / 8);
  const rows = Math.abs(o.height);
  const payload = framePayload(o, f);
  const out = new Uint8Array(rowBytes * rows);
  for (let r = 0; r < rows; r++) {
    out.set(payload.subarray(r * stride, r * stride + rowBytes), r * rowBytes);
  }
  return out;
}

export function buildAvi(o: SynthOptions): Uint8Array {
  const fourcc = o.fourcc ?? 'GREY';
  const bitCount = o.bitCount ?? 8;
  const idx = o.idx ?? 'relative';
  const frameBytes = rowStride(o.width, bitCount) * Math.abs(o.height);
  const fcc = fourcc === '' ? new Uint8Array(4) : enc.encode(fourcc.padEnd(4, ' '));

  const avih = new Uint8Array(56);
  avih.set(u32(o.usec ?? 16666), 0);
  avih.set(u32(o.avihFrames ?? o.frames), 16);
  avih.set(u32(o.width), 32);
  avih.set(u32(Math.abs(o.height)), 36);

  const strh = new Uint8Array(56);
  strh.set(enc.encode('vids'), 0);
  strh.set(fcc, 4);

  const strf = new Uint8Array(40);
  strf.set(u32(40), 0);
  strf.set(u32(o.width), 4);
  strf.set(u32(o.height), 8); // two's complement through >>> 0
  strf.set(u16(1), 12);
  strf.set(u16(bitCount), 14);
  strf.set(fcc, 16);
  strf.set(u32(frameBytes), 20);

  const hdrl = list(
    'hdrl',
    concat(chunk('avih', avih), list('strl', concat(chunk('strh', strh), chunk('strf', strf)))),
  );

  const head = concat(
    enc.encode('RIFF'),
    u32(0),
    enc.encode('AVI '),
    hdrl,
    chunk('JUNK', new Uint8Array(13)),
  );
  const moviFourcc = head.length + 8;
  const frames: Uint8Array[] = [];
  const offsets: number[] = [];
  let rel = 4;
  if (o.junkInMovi) {
    const junk = chunk('JUNK', new Uint8Array(10));
    frames.push(junk);
    rel += junk.length;
  }
  for (let f = 0; f < o.frames; f++) {
    offsets.push(rel);
    const c = chunk('00dc', o.payload ? o.payload(f) : framePayload(o, f + (o.frameOffset ?? 0)));
    frames.push(c);
    rel += c.length;
  }
  const movi = list('movi', concat(...frames));
  if (o.zeroMoviSize) new DataView(movi.buffer).setUint32(4, 0, true);

  const parts = [head, movi];
  if (idx !== 'none') {
    const entries = offsets.map((off) =>
      concat(
        enc.encode('00dc'),
        u32(0x10),
        u32(idx === 'absolute' ? moviFourcc + off : off),
        u32(frameBytes),
      ),
    );
    parts.push(chunk('idx1', concat(...entries)));
  }
  const file = concat(...parts);
  new DataView(file.buffer).setUint32(4, file.length - 8, true);
  return file;
}

/** A Blob-backed File, optionally placed in a folder via `webkitRelativePath`. */
export function makeFile(name: string, data: Uint8Array | string, dir?: string): File {
  const part = typeof data === 'string' ? data : (data as BlobPart);
  const file = new File([part], name);
  if (dir !== undefined) {
    Object.defineProperty(file, 'webkitRelativePath', { value: `${dir}/${name}` });
  }
  return file;
}

/** A deterministic 8-bit calcium movie for the browser tests. */
export interface CellMovie {
  width: number;
  height: number;
  frames: number;
  /** Cell centres `(y, x)`. */
  cells: [number, number][];
  /** Frame `f`'s payload (8-bit, rows padded), for `buildAvi`'s `payload`. Call in frame order. */
  payload(f: number): Uint8Array;
}

/**
 * 16 Gaussian cells (sigma 2.5 px) on a 4 x 4 grid 24 px apart, each with
 * transients about every 5 s at 20 fps (50 to 90 grey levels, decay 8
 * frames), on a background of 30 with Gaussian noise of sd 3. No motion.
 */
export function cellMovie(width = 96, height = 96, frames = 3000, seed = 7): CellMovie {
  let s = seed >>> 0;
  const rand = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const gauss = (): number =>
    Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const cells: [number, number][] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) cells.push([12 + 24 * i, 12 + 24 * j]);
  const traces = cells.map(() => {
    const t = new Float32Array(frames);
    let v = 0;
    for (let f = 0; f < frames; f++) {
      v *= Math.exp(-1 / 8);
      if (rand() < 0.01) v += 50 + 40 * rand();
      t[f] = v;
    }
    return t;
  });
  const r = 8;
  const shape = new Float32Array((2 * r + 1) * (2 * r + 1));
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      shape[(dy + r) * (2 * r + 1) + dx + r] = Math.exp(-(dy * dy + dx * dx) / (2 * 2.5 * 2.5));
  const stride = rowStride(width, 8);
  const image = new Float32Array(width * height);
  return {
    width,
    height,
    frames,
    cells,
    payload(f) {
      for (let p = 0; p < image.length; p++) image[p] = 30 + 3 * gauss();
      cells.forEach(([cy, cx], k) => {
        const a = traces[k][f];
        if (a < 0.5) return;
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++)
            image[(cy + dy) * width + cx + dx] += a * shape[(dy + r) * (2 * r + 1) + dx + r];
      });
      const out = new Uint8Array(stride * height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          out[y * stride + x] = Math.max(0, Math.min(255, Math.round(image[y * width + x])));
      return out;
    },
  };
}
