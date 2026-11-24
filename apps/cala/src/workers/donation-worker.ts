/**
 * Donation worker (docs/data-donation.md): opens its own `FrameSource` over
 * the recording's files, encodes every frame as CALARAW1 chunks
 * (`lib/donation-encode.ts`) and posts each finished chunk back, transferred.
 * Messages: `donation-types.ts`. One donation per worker; the main thread
 * terminates it afterwards.
 *
 * Back-pressure: after posting a chunk the worker waits until no more than
 * `DONATION_CHUNKS_AHEAD` chunks are unacknowledged, so a slow store on the
 * main thread never lets compressed chunks pile up here.
 */
import { initCalaWasm } from '../lib/cala-wasm.ts';
import { DonationCancelled, encodeRecording } from '../lib/donation-encode.ts';
import { FrameSource } from '../lib/frame-source.ts';
import {
  DONATION_CHUNKS_AHEAD,
  type DonationEncodeInput,
  type DonationEvent,
  type DonationRequest,
} from './donation-types.ts';

const workerScope = globalThis as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<DonationRequest>) => void) | null;
};

function post(msg: DonationEvent, transfer: Transferable[] = []): void {
  workerScope.postMessage(msg, transfer);
}

let cancelled = false;
let started = false;
let posted = 0;
let acked = 0;
/** Wakes the encoder waiting for an ack (or a cancel). */
let wake: (() => void) | null = null;

function nudge(): void {
  const w = wake;
  wake = null;
  w?.();
}

async function waitForRoom(): Promise<void> {
  while (!cancelled && posted - acked > DONATION_CHUNKS_AHEAD - 1) {
    await new Promise<void>((resolve) => (wake = resolve));
  }
}

async function run(input: DonationEncodeInput): Promise<void> {
  let source: FrameSource | null = null;
  try {
    await initCalaWasm();
    source =
      'sessions' in input.source
        ? await FrameSource.openSessions(input.source.sessions)
        : await FrameSource.open(input.source.entries);
    const i = source.info;
    const e = input.expect;
    if (
      i.width !== e.width ||
      i.height !== e.height ||
      i.frameCount !== e.frameCount ||
      i.bitDepth !== e.bitDepth
    ) {
      throw new Error(
        `The files changed since the recording was opened (${i.width}x${i.height}, ${i.frameCount} frames, ${i.bitDepth}-bit now).`,
      );
    }
    let lastProgress = 0;
    const chunks = await encodeRecording(source, i, input.fps, {
      chunkBytes: input.chunkBytes,
      cancelled: () => cancelled,
      onProgress: (frames) => {
        // A message per read is plenty, but not more than ~4 per second of a fast read.
        const now = performance.now();
        if (frames === i.frameCount || now - lastProgress > 250) {
          lastProgress = now;
          post({ type: 'progress', frames });
        }
      },
      onChunk: async (chunk) => {
        posted += 1;
        post(
          {
            type: 'chunk',
            index: chunk.index,
            firstFrame: chunk.firstFrame,
            frames: chunk.frames,
            bytes: chunk.bytes,
          },
          [chunk.bytes.buffer as ArrayBuffer],
        );
        await waitForRoom();
      },
    });
    if (cancelled) throw new DonationCancelled();
    post({ type: 'done', chunks });
  } catch (err) {
    if (err instanceof DonationCancelled || cancelled) post({ type: 'cancelled' });
    else post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    source?.dispose();
  }
}

workerScope.onmessage = (e) => {
  const req = e.data;
  switch (req.type) {
    case 'start':
      if (started) {
        post({ type: 'error', message: 'This sharing worker has already started.' });
        return;
      }
      started = true;
      void run(req.input);
      return;
    case 'ack':
      acked = Math.max(acked, req.index + 1);
      nudge();
      return;
    case 'cancel':
      cancelled = true;
      nudge();
      return;
  }
};
