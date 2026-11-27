import type { FramePixels } from '../lib/frame-source.ts';
import type { FrameReader } from '../lib/pipeline-types.ts';

/**
 * The classic seeded generator (`seed * 1103515245 + 12345 mod 2^31`) in [0, 1). The blob movies
 * and a few other tests draw from it, so their seeds fix every pixel.
 */
export function lcgClassic(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/**
 * A small seeded generator in [0, 1) (the delays of a schedule, noise): the numerical-recipes
 * constants on 32 bits. `lcgClassic` is a different stream.
 */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** One Gaussian blob of a movie's texture. */
export interface Blob {
  y: number;
  x: number;
  a: number;
}

/** What `blobMovie` leaves to the caller: the value of one pixel of frame `f`, before clipping. */
export type BlobPixel = (y: number, x: number) => number;

export interface BlobMovieOptions {
  width: number;
  height: number;
  frames: number;
  /** Seed of the `lcgClassic` stream the blobs are drawn from. */
  seed: number;
  /** How many blobs: each draws y, x, then amplitude 40..100 from the stream, in that order. */
  blobs: number;
  /** A frame's pixel function; this is where the scene (shift, flicker, texture) lives. */
  frame: (f: number, blobs: Blob[]) => BlobPixel;
  /** More fields of `info` (sessions). */
  info?: Partial<FrameReader['info']>;
}

/**
 * A seeded blob movie of 8-bit frames over a lit lens disc (radius 0.48 of the width, fixed to
 * the sensor): inside it pixels are `frame(f, blobs)(y, x)` rounded and clipped to 255, outside 3.
 */
export function blobMovie(o: BlobMovieOptions): FrameReader {
  const { width: W, height: H } = o;
  const rand = lcgClassic(o.seed);
  const blobs = Array.from({ length: o.blobs }, () => ({
    y: rand() * H,
    x: rand() * W,
    a: 40 + rand() * 60,
  }));
  return {
    info: { width: W, height: H, bitDepth: 8, frameCount: o.frames, fps: 20, ...o.info },
    async readFrames(start: number, count: number, out?: FramePixels) {
      const dst = (out as Uint8Array | undefined) ?? new Uint8Array(count * W * H);
      for (let i = 0; i < count; i++) {
        const pixel = o.frame(start + i, blobs);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const lit = (y - H / 2) ** 2 + (x - W / 2) ** 2 < (0.48 * W) ** 2;
            dst[i * W * H + y * W + x] = lit ? Math.min(255, Math.round(pixel(y, x))) : 3;
          }
        }
      }
      return dst;
    },
  };
}
