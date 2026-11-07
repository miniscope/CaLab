import type { FrameSourceInfo } from '../lib/frame-source.ts';

/** Main thread -> frame worker. `id` pairs a request with its response. */
export type FrameRequest =
  { type: 'open'; id: number; files: File[] } | { type: 'read'; id: number; index: number };

/** A request before the client stamps it with an `id` (distributes over the union). */
export type FrameRequestBody = FrameRequest extends infer R
  ? R extends FrameRequest
    ? Omit<R, 'id'>
    : never
  : never;

/** Frame worker -> main thread. */
export type FrameResponse =
  | { type: 'opened'; id: number; info: FrameSourceInfo }
  | {
      type: 'frame';
      id: number;
      index: number;
      /** `width * height` bytes (x2 for 16-bit). Transferred, not copied. */
      pixels: Uint8Array;
    }
  | { type: 'error'; id: number; message: string };
