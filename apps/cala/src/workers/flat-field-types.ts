/**
 * Messages of the flat-field worker (see `lib/flat-field-runner.ts`). The main
 * thread creates the worker and a `MessageChannel` between it and the frame
 * worker (stage A): batches and maps travel on that port, status events go to
 * the main thread over the worker's own channel.
 */
import type { FlatFieldMap } from '../lib/flat-field.ts';
import type { FlatFieldBatch, FlatFieldStart } from '../lib/flat-field-runner.ts';

/** Main thread -> flat-field worker: its port to the frame worker. */
export interface FlatFieldLink {
  type: 'flat-link';
  port: MessagePort;
}

/** Frame worker -> flat-field worker (over the port). */
export type FlatFieldDown =
  ({ type: 'start' } & FlatFieldStart) | ({ type: 'batch' } & FlatFieldBatch) | { type: 'stop' };

/** Flat-field worker -> frame worker (over the port). */
export type FlatFieldUp =
  /** A batch left the queue (the frame worker's queue bound counts these). */
  | { type: 'ack'; session: number }
  | { type: 'map'; session: number; seq: number; map: FlatFieldMap };
