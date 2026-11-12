// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LIVE_HEADER_BYTES, LIVE_MAGIC } from '../lib/live-source.ts';
import {
  OP_BINARY,
  OP_PING,
  OP_TEXT,
  acceptKey,
  binaryFrame,
  frameHeader,
  parseClientFrames,
  textFrame,
} from '../lib/live-sim-protocol.ts';

/** A masked client frame, as a browser sends. */
function clientFrame(opcode: number, payload: Buffer, mask = Buffer.from([1, 2, 3, 4])): Buffer {
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  const head = frameHeader(opcode, payload.length);
  head[1] |= 0x80;
  return Buffer.concat([head.subarray(0, 2), head.subarray(2), mask, masked]);
}

describe('frameHeader', () => {
  it('uses 1, 2 and 8 length bytes at the RFC 6455 thresholds', () => {
    expect([...frameHeader(OP_BINARY, 125)]).toEqual([0x82, 125]);
    expect([...frameHeader(OP_BINARY, 126)]).toEqual([0x82, 126, 0, 126]);
    expect([...frameHeader(OP_BINARY, 65535)]).toEqual([0x82, 126, 255, 255]);
    const big = frameHeader(OP_BINARY, 65536);
    expect(big.length).toBe(10);
    expect(big[1]).toBe(127);
    expect(big.readBigUInt64BE(2)).toBe(65536n);
  });
});

describe('acceptKey', () => {
  it('matches the RFC 6455 worked example', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('textFrame', () => {
  it('carries JSON as one final text frame', () => {
    const f = textFrame({ type: 'end', frames: 3 });
    expect(f[0]).toBe(0x80 | OP_TEXT);
    expect(JSON.parse(f.subarray(2).toString())).toEqual({ type: 'end', frames: 3 });
  });
});

describe('binaryFrame', () => {
  it('is a binary frame of the 16-byte cala header plus the pixels', () => {
    const pixels = Uint8Array.from([9, 8, 7, 6, 5, 4]);
    const f = binaryFrame(42, 1234.5, pixels);
    expect(f[0]).toBe(0x80 | OP_BINARY);
    expect(f[1]).toBe(LIVE_HEADER_BYTES + pixels.length);
    const body = f.subarray(2);
    expect(body.readUInt32LE(0)).toBe(LIVE_MAGIC);
    expect(body.readUInt32LE(4)).toBe(42);
    expect(body.readDoubleLE(8)).toBe(1234.5);
    expect([...body.subarray(LIVE_HEADER_BYTES)]).toEqual([...pixels]);
  });

  it('uses the 16-bit length form for a frame that needs it', () => {
    const f = binaryFrame(0, 0, new Uint8Array(1000));
    expect(f[1]).toBe(126);
    expect(f.readUInt16BE(2)).toBe(LIVE_HEADER_BYTES + 1000);
    expect(f.length).toBe(4 + LIVE_HEADER_BYTES + 1000);
  });
});

describe('parseClientFrames', () => {
  it('unmasks a client frame', () => {
    const seen: Array<[number, string]> = [];
    const rest = parseClientFrames(clientFrame(OP_PING, Buffer.from('hi')), (op, p) =>
      seen.push([op, p.toString()]),
    );
    expect(seen).toEqual([[OP_PING, 'hi']]);
    expect(rest.length).toBe(0);
  });

  it('handles two frames and keeps an incomplete tail for the next read', () => {
    const a = clientFrame(OP_TEXT, Buffer.from('one'));
    const b = clientFrame(OP_TEXT, Buffer.alloc(300, 0x41));
    const all = Buffer.concat([a, b]);
    const seen: number[] = [];
    const rest = parseClientFrames(all.subarray(0, all.length - 10), (_, p) => seen.push(p.length));
    expect(seen).toEqual([3]);
    const more = parseClientFrames(Buffer.concat([rest, all.subarray(all.length - 10)]), (_, p) =>
      seen.push(p.length),
    );
    expect(seen).toEqual([3, 300]);
    expect(more.length).toBe(0);
  });
});
