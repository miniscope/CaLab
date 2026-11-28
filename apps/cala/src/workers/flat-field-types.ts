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
  | ({ type: 'start' } & FlatFieldStart)
  | ({ type: 'batch' } & FlatFieldBatch)
  /**
   * The recording ended (no batch of `session` follows): once the batches
   * before it are in, the worker tells the main thread its last map is out
   * (`FlatFieldEvent` `finished`).
   */
  | { type: 'finish'; session: number }
  | { type: 'stop' };

/** Flat-field worker -> frame worker (over the port). */
export type FlatFieldUp =
  /** A batch left the queue (the frame worker's queue bound counts these). */
  | { type: 'ack'; session: number }
  | { type: 'map'; session: number; seq: number; map: FlatFieldMap }
  /**
   * The batch that starts at `start` went through the estimator (pushed, and refined if due; any
   * map it made was sent before this): `seq` is the newest map's sequence number (0: none yet).
   * Stage A of a repeatable run schedules maps by it (`FrontStage`).
   */
  | { type: 'pushed'; session: number; start: number; seq: number };
