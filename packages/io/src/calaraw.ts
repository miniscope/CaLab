// CALARAW1: raw recording frames for data donation
// (apps/cala/docs/data-donation.md).
//
// A recording is cut into chunks of whole frames. Each chunk is one gzip file
// (`frames-0000.calaraw.gz`, ...) that holds, before compression:
//
//   offset size
//    0      8   magic "CALARAW1"
//    8      4   u32 width
//   12      4   u32 height
//   16      4   u32 first frame of this chunk in the recording
//   20      4   u32 frames in this chunk
//   24      4   u32 frames in the recording
//   28      1   u8  bytes per pixel (1: uint8, 2: uint16)
//   29      1   u8  predictor (0: none, 1: up)
//   30      2   u16 reserved, 0
//   32      8   f64 frames per second
//   40      ..  frames, row-major, little-endian
//
// Predictor "up" stores each pixel minus the pixel above it, wrapping modulo
// 2^(8 * bytes per pixel); the first row is stored as is. It is lossless, keeps
// frames independent, and inverts as a cumulative sum down the rows. On
// miniscope video it shrinks the gzip output by ~15% (the noise bounds the
// rest). Compression is the platform's `CompressionStream('gzip')`, so the
// browser needs no extra codec and any gzip reader opens a chunk.

export const CALARAW_MAGIC = 'CALARAW1';
export const CALARAW_HEADER_BYTES = 40;
/** Uncompressed bytes per chunk the encoder aims for (whole frames, at least one). */
export const CALARAW_CHUNK_BYTES = 64 * 1024 * 1024;
/** Largest frame edge accepted, px. */
export const CALARAW_MAX_EDGE = 16384;

export type CalarawFrame = Uint8Array | Uint16Array;
export type CalarawPredictor = 0 | 1;

/** What stays the same across the chunks of one recording. */
export interface CalarawMeta {
  width: number;
  height: number;
  totalFrames: number;
  bytesPerPixel: 1 | 2;
  predictor: CalarawPredictor;
  fps: number;
}

export interface CalarawHeader extends CalarawMeta {
  firstFrame: number;
  frames: number;
}

export interface CalarawChunk {
  index: number;
  firstFrame: number;
  frames: number;
  /** The gzip file. */
  bytes: Uint8Array;
}

export class CalarawError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalarawError';
  }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const isU32 = (v: number): boolean => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

function checkMeta(m: CalarawMeta): void {
  for (const [name, edge] of [
    ['width', m.width],
    ['height', m.height],
  ] as const) {
    if (!Number.isInteger(edge) || edge < 1 || edge > CALARAW_MAX_EDGE) {
      throw new CalarawError(`${name} ${edge} outside 1..${CALARAW_MAX_EDGE}`);
    }
  }
  if (!isU32(m.totalFrames) || m.totalFrames < 1) {
    throw new CalarawError(`total frames ${m.totalFrames} is not a positive u32`);
  }
  if (m.bytesPerPixel !== 1 && m.bytesPerPixel !== 2) {
    throw new CalarawError(`bytes per pixel ${m.bytesPerPixel} is not 1 or 2`);
  }
  if (m.predictor !== 0 && m.predictor !== 1) {
    throw new CalarawError(`unknown predictor ${m.predictor}`);
  }
  if (!Number.isFinite(m.fps) || m.fps <= 0) {
    throw new CalarawError(`fps ${m.fps} is not a positive number`);
  }
}

function checkHeader(h: CalarawHeader): void {
  checkMeta(h);
  if (!isU32(h.firstFrame) || !isU32(h.frames) || h.frames < 1) {
    throw new CalarawError(`chunk frames ${h.firstFrame}+${h.frames} are not u32 with frames >= 1`);
  }
  if (h.firstFrame + h.frames > h.totalFrames) {
    throw new CalarawError(
      `chunk frames ${h.firstFrame}+${h.frames} run past the recording's ${h.totalFrames}`,
    );
  }
}

/** The 40-byte header of a chunk. */
export function writeCalarawHeader(h: CalarawHeader): Uint8Array {
  checkHeader(h);
  const b = new Uint8Array(CALARAW_HEADER_BYTES);
  const v = new DataView(b.buffer);
  for (let i = 0; i < 8; i++) b[i] = CALARAW_MAGIC.charCodeAt(i);
  v.setUint32(8, h.width, true);
  v.setUint32(12, h.height, true);
  v.setUint32(16, h.firstFrame, true);
  v.setUint32(20, h.frames, true);
  v.setUint32(24, h.totalFrames, true);
  v.setUint8(28, h.bytesPerPixel);
  v.setUint8(29, h.predictor);
  v.setFloat64(32, h.fps, true);
  return b;
}

/** Inverse of {@link writeCalarawHeader}; throws {@link CalarawError} on anything invalid. */
export function parseCalarawHeader(b: Uint8Array): CalarawHeader {
  if (b.length < CALARAW_HEADER_BYTES) throw new CalarawError('truncated header');
  for (let i = 0; i < 8; i++) {
    if (b[i] !== CALARAW_MAGIC.charCodeAt(i)) throw new CalarawError('not a CALARAW1 chunk');
  }
  const v = new DataView(b.buffer, b.byteOffset, CALARAW_HEADER_BYTES);
  if (v.getUint16(30, true) !== 0) throw new CalarawError('reserved header bytes are not 0');
  const h: CalarawHeader = {
    width: v.getUint32(8, true),
    height: v.getUint32(12, true),
    firstFrame: v.getUint32(16, true),
    frames: v.getUint32(20, true),
    totalFrames: v.getUint32(24, true),
    bytesPerPixel: v.getUint8(28) as 1 | 2,
    predictor: v.getUint8(29) as CalarawPredictor,
    fps: v.getFloat64(32, true),
  };
  checkHeader(h);
  return h;
}

// ---------------------------------------------------------------------------
// Predictor
// ---------------------------------------------------------------------------

// Typed-array stores wrap modulo 2^bits, which is the predictor's arithmetic.
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function frameBytes(m: CalarawMeta): number {
  return m.width * m.height * m.bytesPerPixel;
}

function checkFrame(m: CalarawMeta, frame: CalarawFrame): void {
  const wanted = m.bytesPerPixel === 1 ? Uint8Array : Uint16Array;
  if (!(frame instanceof wanted)) {
    throw new CalarawError(`frame is not a ${wanted.name} (bytes per pixel ${m.bytesPerPixel})`);
  }
  if (frame.length !== m.width * m.height) {
    throw new CalarawError(`frame has ${frame.length} pixels, not ${m.width * m.height}`);
  }
}

/** The stored (predicted) form of `frame`, as bytes, into `out` at `offset`. */
function encodeFrame(m: CalarawMeta, frame: CalarawFrame, out: Uint8Array, offset: number): void {
  const n = m.width * m.height;
  const r =
    m.bytesPerPixel === 1
      ? out.subarray(offset, offset + n)
      : new Uint16Array(out.buffer, out.byteOffset + offset, n);
  if (m.predictor === 0) {
    r.set(frame);
    return;
  }
  const w = m.width;
  r.set(frame.subarray(0, w));
  for (let i = w; i < n; i++) r[i] = frame[i] - frame[i - w];
}

/** Inverse of {@link encodeFrame}, in place. */
function decodeFrameInPlace(m: CalarawMeta, r: CalarawFrame): void {
  if (m.predictor === 0) return;
  const w = m.width;
  for (let i = w; i < r.length; i++) r[i] = r[i] + r[i - w];
}

// ---------------------------------------------------------------------------
// gzip
// ---------------------------------------------------------------------------

async function gzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Gunzip `gz` into exactly `limit` bytes at most: reading stops (and throws)
 * as soon as the output would pass it, so a hostile chunk cannot inflate
 * without bound.
 */
async function gunzipBounded(gz: Uint8Array<ArrayBuffer>, limit: number): Promise<Uint8Array> {
  const reader = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const out = new Uint8Array(limit);
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > limit) {
      await reader.cancel();
      throw new CalarawError(`chunk inflates past ${limit} bytes`);
    }
    out.set(value, at);
    at += value.length;
  }
  return out.subarray(0, at);
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/** One chunk file: `frames` (whole frames of the recording) from `firstFrame`. */
export async function encodeCalarawChunk(
  meta: CalarawMeta,
  firstFrame: number,
  frames: readonly CalarawFrame[],
): Promise<Uint8Array> {
  if (!littleEndian) throw new CalarawError('big-endian platforms are not supported');
  const header = writeCalarawHeader({ ...meta, firstFrame, frames: frames.length });
  const fb = frameBytes(meta);
  const raw = new Uint8Array(CALARAW_HEADER_BYTES + frames.length * fb);
  raw.set(header);
  frames.forEach((f, i) => {
    checkFrame(meta, f);
    encodeFrame(meta, f, raw, CALARAW_HEADER_BYTES + i * fb);
  });
  return gzip(raw);
}

/** Whole frames per chunk for a target uncompressed size (at least one). */
export function calarawFramesPerChunk(meta: CalarawMeta, chunkBytes = CALARAW_CHUNK_BYTES): number {
  return Math.max(1, Math.floor(chunkBytes / frameBytes(meta)));
}

/**
 * Encode a recording chunk by chunk. `frames` must yield exactly
 * `meta.totalFrames` frames; chunks are yielded as soon as they are full so
 * memory stays at about one chunk.
 */
export async function* encodeCalaraw(
  meta: CalarawMeta,
  frames: AsyncIterable<CalarawFrame> | Iterable<CalarawFrame>,
  chunkBytes = CALARAW_CHUNK_BYTES,
): AsyncGenerator<CalarawChunk> {
  checkMeta(meta);
  const perChunk = calarawFramesPerChunk(meta, chunkBytes);
  let pending: CalarawFrame[] = [];
  let firstFrame = 0;
  let index = 0;
  const flush = async (): Promise<CalarawChunk> => {
    const chunk = {
      index,
      firstFrame,
      frames: pending.length,
      bytes: await encodeCalarawChunk(meta, firstFrame, pending),
    };
    index += 1;
    firstFrame += pending.length;
    pending = [];
    return chunk;
  };
  for await (const frame of frames) {
    if (firstFrame + pending.length >= meta.totalFrames) {
      throw new CalarawError(`more than ${meta.totalFrames} frames`);
    }
    checkFrame(meta, frame);
    pending.push(frame);
    if (pending.length === perChunk) yield await flush();
  }
  if (pending.length > 0) yield await flush();
  if (firstFrame !== meta.totalFrames) {
    throw new CalarawError(`got ${firstFrame} frames, header says ${meta.totalFrames}`);
  }
}

/** File name of chunk `index` in a donation. */
export function calarawChunkName(index: number): string {
  return `frames-${String(index).padStart(4, '0')}.calaraw.gz`;
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/**
 * Decode one chunk file. Checks the header, that the payload is exactly the
 * declared frames, and inflates no further than that. `maxBytes` caps the
 * uncompressed size the header may declare (default: 4x the encoder's chunk).
 */
export async function decodeCalarawChunk(
  gz: Uint8Array<ArrayBuffer>,
  maxBytes = 4 * CALARAW_CHUNK_BYTES,
): Promise<{ header: CalarawHeader; frames: CalarawFrame[] }> {
  if (!littleEndian) throw new CalarawError('big-endian platforms are not supported');
  // Read the header first so the declared size can be checked before inflating it all.
  const head = await gunzipBounded(gz, maxBytes + CALARAW_HEADER_BYTES).catch((e: unknown) => {
    if (e instanceof CalarawError) throw e;
    throw new CalarawError(`not a gzip file: ${String(e)}`);
  });
  const header = parseCalarawHeader(head);
  const fb = frameBytes(header);
  const expected = CALARAW_HEADER_BYTES + header.frames * fb;
  if (expected - CALARAW_HEADER_BYTES > maxBytes) {
    throw new CalarawError(`chunk declares ${expected} bytes, more than ${maxBytes}`);
  }
  if (head.length !== expected) {
    throw new CalarawError(`chunk holds ${head.length} bytes, header says ${expected}`);
  }
  const frames: CalarawFrame[] = [];
  for (let t = 0; t < header.frames; t++) {
    // Copy so each frame owns an aligned buffer.
    const bytes = head.slice(CALARAW_HEADER_BYTES + t * fb, CALARAW_HEADER_BYTES + (t + 1) * fb);
    const frame = header.bytesPerPixel === 1 ? bytes : new Uint16Array(bytes.buffer);
    decodeFrameInPlace(header, frame);
    frames.push(frame);
  }
  return { header, frames };
}
