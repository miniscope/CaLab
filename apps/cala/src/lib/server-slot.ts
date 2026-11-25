/**
 * The look-back worker's frame server and the newest library it was sent.
 * A recording's settle with `?factors=file` switches worker 0 from the file
 * to the factors (slice 3); the new server gets the newest library at once,
 * so it never solves without one, whatever order the switch and a library
 * message come in.
 */
import type { FrameServer } from './factor-reader.ts';

export class ServerSlot {
  private lib: { version: number; bytes: Uint8Array } | null = null;
  constructor(private current: FrameServer) {}

  get server(): FrameServer {
    return this.current;
  }

  setLibrary(version: number, bytes: Uint8Array): void {
    if (!this.lib || version > this.lib.version) this.lib = { version, bytes };
    this.current.setLibrary(version, bytes);
  }

  /** Serve with `next` from now on; returns the server it replaced (the caller disposes it at the run's end). */
  swap(next: FrameServer): FrameServer {
    const old = this.current;
    this.current = next;
    if (this.lib) next.setLibrary(this.lib.version, this.lib.bytes);
    return old;
  }
}
