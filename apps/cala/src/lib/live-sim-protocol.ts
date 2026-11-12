/**
 * The sending side of the live-source protocol (`live-source.ts` is the
 * receiving side): RFC 6455 framing for a server (unmasked frames out,
 * masked client frames in) and the 16-byte cala frame header. Used by
 * `scripts/live-sim.mjs` (`npm run sim-stream`); kept here, dependency-free
 * and unit-tested, so the two sides cannot drift apart.
 */
import { createHash } from 'node:crypto';
import { LIVE_HEADER_BYTES, LIVE_MAGIC } from './live-source.ts';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OP_TEXT = 1;
export const OP_BINARY = 2;
export const OP_CLOSE = 8;
export const OP_PING = 9;
export const OP_PONG = 10;

/** `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`. */
export function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
}

/** Header of one final, unmasked frame with `opcode` and a payload of `length` bytes. */
export function frameHeader(opcode: number, length: number): Buffer {
  if (length < 126) return Buffer.from([0x80 | opcode, length]);
  if (length < 65536) {
    const h = Buffer.alloc(4);
    h[0] = 0x80 | opcode;
    h[1] = 126;
    h.writeUInt16BE(length, 2);
    return h;
  }
  const h = Buffer.alloc(10);
  h[0] = 0x80 | opcode;
  h[1] = 127;
  h.writeBigUInt64BE(BigInt(length), 2);
  return h;
}

/** A whole text frame carrying `obj` as JSON (hello, end). */
export function textFrame(obj: object): Buffer {
  const body = Buffer.from(JSON.stringify(obj));
  return Buffer.concat([frameHeader(OP_TEXT, body.length), body]);
}

/** The 16-byte cala header: magic, acquisition-side frame index, timestamp (ms since epoch). */
export function liveFrameHeader(index: number, stampMs: number): Buffer {
  const head = Buffer.alloc(LIVE_HEADER_BYTES);
  head.writeUInt32LE(LIVE_MAGIC, 0);
  head.writeUInt32LE(index >>> 0, 4);
  head.writeDoubleLE(stampMs, 8);
  return head;
}

/** A whole binary frame: WebSocket header, cala header, raw pixels. */
export function binaryFrame(index: number, stampMs: number, pixels: Uint8Array): Buffer {
  const head = liveFrameHeader(index, stampMs);
  return Buffer.concat([frameHeader(OP_BINARY, head.length + pixels.length), head, pixels]);
}

/** A close or pong reply echoing `payload`. */
export function controlFrame(opcode: number, payload: Buffer): Buffer {
  return Buffer.concat([frameHeader(opcode, payload.length), payload]);
}

/**
 * Parse the client's frames (masked, as RFC 6455 requires of clients) out of
 * `buf`, calling `onFrame` for each complete one; returns the bytes of the
 * incomplete tail to prepend to the next read.
 */
export function parseClientFrames(
  buf: Buffer,
  onFrame: (opcode: number, payload: Buffer) => void,
): Buffer {
  let at = 0;
  for (;;) {
    if (buf.length - at < 2) break;
    const opcode = buf[at] & 0x0f;
    const masked = (buf[at + 1] & 0x80) !== 0;
    let len = buf[at + 1] & 0x7f;
    let p = at + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length - p < maskLen + len) break;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    const payload = Buffer.from(buf.subarray(p + maskLen, p + maskLen + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    onFrame(opcode, payload);
    at = p + maskLen + len;
  }
  return buf.subarray(at);
}
