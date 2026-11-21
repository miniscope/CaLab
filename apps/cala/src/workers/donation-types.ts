/**
 * Messages between the main thread and the donation worker
 * (`donation-worker.ts`, docs/data-donation.md). One worker per donation: it
 * opens its own `FrameSource` over the recording's files, encodes every frame
 * as CALARAW1 chunks and posts each chunk back (transferred). It stays at most
 * `DONATION_CHUNKS_AHEAD` chunks ahead of the acks, so memory stays at a few
 * chunks however long the recording is.
 */
import type { FolderEntry, SessionInput } from '../lib/frame-source.ts';

/** Chunks the worker may have posted without an ack. */
export const DONATION_CHUNKS_AHEAD = 2;

/** The recording to encode: a folder's files, or sessions opened as one recording. */
export type DonationSource = { entries: FolderEntry[] } | { sessions: SessionInput[] };

export interface DonationEncodeInput {
  source: DonationSource;
  /** Frame rate written into every chunk header, Hz. */
  fps: number;
  /** What the main thread saw when it opened the recording: the worker refuses a mismatch. */
  expect: { width: number; height: number; frameCount: number; bitDepth: number };
  /** Uncompressed bytes per chunk (default `CALARAW_CHUNK_BYTES`). */
  chunkBytes?: number;
}

/** Main thread -> donation worker. */
export type DonationRequest =
  | { type: 'start'; input: DonationEncodeInput }
  /** Chunk `index` is stored: the worker may run further ahead. */
  | { type: 'ack'; index: number }
  | { type: 'cancel' };

/** Donation worker -> main thread. */
export type DonationEvent =
  /** Frames read so far. */
  | { type: 'progress'; frames: number }
  | {
      type: 'chunk';
      index: number;
      firstFrame: number;
      frames: number;
      /** The gzip file. Transferred. */
      bytes: Uint8Array;
    }
  | { type: 'done'; chunks: number }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };
