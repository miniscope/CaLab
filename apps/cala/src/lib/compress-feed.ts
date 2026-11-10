/**
 * The fast worker's side of the compression: cuts the stream of preprocessed
 * frames into windows, quantizes each batch in tile order and transfers it to
 * the compress worker. Pure apart from the injected quantizer and port, so
 * the window bookkeeping is unit-tested without WASM or workers.
 */
import type { FastToCompress } from '../workers/compress-types.ts';
import type { PortLike } from '../workers/slow-types.ts';

/** `quantizeTiles` of the WASM module. */
export type QuantizeTiles = (
  frames: Float32Array,
  count: number,
  width: number,
  height: number,
  tile: number,
  quant: number,
  out: Int16Array,
) => void;

export interface CompressFeedOptions {
  width: number;
  height: number;
  session: number;
  /** Tile edge, px. */
  tile?: number;
  /** Frames per window. */
  window?: number;
  /** Quantized values are `round(value * quant)`: 1/64 grey level, ±512 grey levels. */
  quant?: number;
}

export const COMPRESS_DEFAULTS = { tile: 64, window: 600, quant: 64 } as const;

/** What the fast loop needs of a feed. */
export interface CompressFeedLike {
  push(batch: Float32Array, start: number, count: number): void;
  /** A library the slow loop published (the bytes are copied). */
  library(version: number, bytes: Uint8Array): void;
  end(): void;
  reset(): void;
}

export class CompressFeed implements CompressFeedLike {
  private readonly o: Required<CompressFeedOptions>;
  private readonly px: number;
  private initSent = false;
  /** Frames in the open window, its index, and the stream frame expected next. */
  private filled = 0;
  private windowIndex = 0;
  private next = -1;
  private ended = false;
  private disposed = false;

  constructor(
    options: CompressFeedOptions,
    private readonly port: PortLike<FastToCompress>,
    private readonly quantize: QuantizeTiles,
  ) {
    this.o = { ...COMPRESS_DEFAULTS, ...options };
    if (!(this.o.window >= 2) || !(this.o.tile >= 1) || !(this.o.quant > 0)) {
      throw new RangeError('CompressFeed needs window >= 2, tile >= 1, quant > 0.');
    }
    this.px = options.width * options.height;
  }

  /** `count` frames that start at stream frame `start`. */
  push(batch: Float32Array, start: number, count: number): void {
    if (this.disposed || count <= 0) return;
    const { session, width, height, tile, window, quant } = this.o;
    if (!this.initSent) {
      this.port.postMessage({ type: 'init', session, width, height, tile, window, quant });
      this.initSent = true;
    }
    // A gap in the stream ends the window: its frames must be consecutive.
    if (this.next >= 0 && start !== this.next) this.close(false);
    let done = 0;
    while (done < count) {
      const n = Math.min(count - done, window - this.filled);
      const data = new Int16Array(n * this.px);
      this.quantize(
        batch.subarray(done * this.px, (done + n) * this.px),
        n,
        width,
        height,
        tile,
        quant,
        data,
      );
      this.filled += n;
      const last = this.filled >= window;
      this.port.postMessage(
        {
          type: 'chunk',
          session,
          window: this.windowIndex,
          start: start + done,
          count: n,
          last,
          data,
        },
        [data.buffer as ArrayBuffer],
      );
      if (last) {
        this.windowIndex++;
        this.filled = 0;
      }
      done += n;
    }
    this.next = start + count;
  }

  library(version: number, bytes: Uint8Array): void {
    if (this.disposed || !this.initSent) return;
    const copy = bytes.slice();
    this.port.postMessage({ type: 'library', session: this.o.session, version, bytes: copy }, [
      copy.buffer as ArrayBuffer,
    ]);
  }

  private close(final: boolean): void {
    if (this.filled > 0) {
      this.windowIndex++;
      this.filled = 0;
    }
    this.port.postMessage({ type: 'close', session: this.o.session, final });
  }

  /** The recording ended: compress the last, shorter window too. */
  end(): void {
    if (this.disposed || !this.initSent || this.ended) return;
    this.ended = true;
    this.close(true);
  }

  /**
   * The fast loop is dropped. Before the end of the recording that is a stop
   * or restart, and the compress worker drops its windows too. After it (pass
   * 2 replaces the fast loop in the same worker) the windows stay: they are
   * the record of the run, and the next run's `init` clears them.
   */
  reset(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.initSent && !this.ended) {
      this.port.postMessage({ type: 'reset', session: this.o.session });
    }
  }
}
