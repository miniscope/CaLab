/**
 * Flat-field worker: owns the `FlatFieldEstimator`. The frame worker (stage A)
 * sends it raw batches with the shifts stage B found; it pushes them, runs the
 * expensive `refine()` when due, and posts each new map to stage A (applied at
 * its next batch boundary) and to the main thread (display and cache). Nothing
 * waits for this worker: stage A drops batches when more than
 * `FLAT_FIELD_MAX_QUEUE` are unanswered. See `lib/pipeline-stages.ts`.
 */
import { initCalaWasm } from '../lib/cala-wasm.ts';
import type { FlatFieldEvent } from '../lib/flat-field.ts';
import { FlatFieldRunner } from '../lib/flat-field-runner.ts';
import type { FlatFieldDown, FlatFieldLink, FlatFieldUp } from './flat-field-types.ts';

const scope = globalThis as unknown as {
  postMessage(msg: FlatFieldEvent): void;
  onmessage: ((e: MessageEvent<FlatFieldLink>) => void) | null;
};

let port: MessagePort | null = null;
let session = -1;
let queue: Promise<void> = Promise.resolve();

const runner = new FlatFieldRunner(
  (e) => scope.postMessage(e),
  (s, seq, map) => {
    const msg: FlatFieldUp = { type: 'map', session: s, seq, map };
    port?.postMessage(msg, [map.gain.buffer as ArrayBuffer, map.offset.buffer as ArrayBuffer]);
  },
);

async function handle(msg: FlatFieldDown): Promise<void> {
  switch (msg.type) {
    case 'start':
      await initCalaWasm();
      session = msg.session;
      try {
        runner.start(msg);
      } catch (err) {
        scope.postMessage({
          type: 'error',
          session: msg.session,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    case 'batch':
      // Ack as the batch leaves the queue: the bound counts batches waiting,
      // and a refine can take a second while the next ones arrive.
      port?.postMessage({ type: 'ack', session: msg.session } satisfies FlatFieldUp);
      if (msg.session === session) runner.push(msg);
      break;
    case 'stop':
      runner.stop();
      session = -1;
      break;
  }
}

scope.onmessage = (e) => {
  if (e.data.type !== 'flat-link') return;
  port?.close();
  port = e.data.port;
  port.onmessage = (ev: MessageEvent<FlatFieldDown>) => {
    const msg = ev.data;
    queue = queue.then(() => handle(msg)).catch(() => {});
  };
};
