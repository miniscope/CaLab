/**
 * Encoding an opened recording as CALARAW1 chunks for data donation
 * (docs/data-donation.md). Pure: the donation worker
 * (`workers/donation-worker.ts`) drives it over its own `FrameSource`, and the
 * tests drive it over a synthetic AVI.
 *
 * Frames are read in order, `MAX_FRAMES_PER_READ` at a time, and handed to
 * `encodeCalaraw` one by one (views into each read's buffer, never reused, so
 * the frames a chunk holds stay valid until it is compressed). 8-bit video is
 * stored with 1 byte per pixel, 16-bit with 2 (`FrameSource` returns 16-bit
 * frames as a `Uint16Array` on a little-endian host, which is what CALARAW1
 * stores).
 */
import {
  CALARAW_CHUNK_BYTES,
  encodeCalaraw,
  type CalarawChunk,
  type CalarawFrame,
  type CalarawMeta,
} from '@calab/io';
import { MAX_FRAMES_PER_READ, type FramePixels } from './frame-source.ts';

/** What the encoder needs to know about the recording. */
export interface DonationGeometry {
  width: number;
  height: number;
  frameCount: number;
  /** 8 or 16. */
  bitDepth: number;
}

/** The part of `FrameSource` the encoder reads through. */
export interface SequentialReader {
  readFrames(start: number, count: number): Promise<FramePixels>;
}

/** Thrown out of `encodeRecording` when `cancelled()` turns true. */
export class DonationCancelled extends Error {
  constructor() {
    super('Sharing cancelled');
    this.name = 'DonationCancelled';
  }
}

/** Bytes per stored pixel for a bit depth CALARAW1 can hold. */
export function bytesPerPixelFor(bitDepth: number): 1 | 2 {
  if (bitDepth === 8) return 1;
  if (bitDepth === 16) return 2;
  throw new Error(`${bitDepth}-bit video cannot be shared (8 or 16 bit only).`);
}

/** The CALARAW1 meta of a recording (predictor "up"). */
export function calarawMetaFor(g: DonationGeometry, fps: number): CalarawMeta {
  return {
    width: g.width,
    height: g.height,
    totalFrames: g.frameCount,
    bytesPerPixel: bytesPerPixelFor(g.bitDepth),
    predictor: 1,
    fps,
  };
}

/** Every frame of the recording, in order, as views into fresh read buffers. */
export async function* sequentialFrames(
  reader: SequentialReader,
  g: DonationGeometry,
  opts: { span?: number; cancelled?: () => boolean; onRead?: (framesRead: number) => void } = {},
): AsyncGenerator<CalarawFrame> {
  const span = Math.max(1, Math.min(opts.span ?? MAX_FRAMES_PER_READ, MAX_FRAMES_PER_READ));
  const px = g.width * g.height;
  for (let start = 0; start < g.frameCount; start += span) {
    if (opts.cancelled?.()) throw new DonationCancelled();
    const count = Math.min(span, g.frameCount - start);
    const pixels = await reader.readFrames(start, count);
    if (pixels.length !== count * px) {
      throw new Error(`Read ${pixels.length} samples for ${count} frames of ${px} pixels.`);
    }
    for (let t = 0; t < count; t++) yield pixels.subarray(t * px, (t + 1) * px);
    opts.onRead?.(start + count);
  }
}

export interface EncodeOptions {
  /** Called with each finished chunk; the next chunk is not started before it resolves. */
  onChunk: (chunk: CalarawChunk) => Promise<void>;
  /** Frames read so far. */
  onProgress?: (frames: number) => void;
  cancelled?: () => boolean;
  /** Uncompressed bytes per chunk (tests use small chunks). */
  chunkBytes?: number;
  /** Frames per read (at most `MAX_FRAMES_PER_READ`). */
  span?: number;
}

/** Encode the whole recording; resolves with the number of chunks. */
export async function encodeRecording(
  reader: SequentialReader,
  g: DonationGeometry,
  fps: number,
  opts: EncodeOptions,
): Promise<number> {
  const meta = calarawMetaFor(g, fps);
  const frames = sequentialFrames(reader, g, {
    span: opts.span,
    cancelled: opts.cancelled,
    onRead: opts.onProgress,
  });
  let chunks = 0;
  for await (const chunk of encodeCalaraw(meta, frames, opts.chunkBytes ?? CALARAW_CHUNK_BYTES)) {
    if (opts.cancelled?.()) throw new DonationCancelled();
    await opts.onChunk(chunk);
    chunks += 1;
  }
  return chunks;
}
