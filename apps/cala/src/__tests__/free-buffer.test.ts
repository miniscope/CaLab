import { describe, expect, it } from 'vitest';
import { freeBuffer } from '../lib/free-buffer.ts';

describe('freeBuffer', () => {
  it('releases a consumed buffer at once (every view empties)', () => {
    const a = new Uint8Array(1 << 20).fill(7);
    const b = new Float32Array(a.buffer, 0, 16);
    freeBuffer(a);
    expect(a.buffer.byteLength).toBe(0);
    expect(a.length).toBe(0);
    expect(b.length).toBe(0);
    // Twice is harmless.
    freeBuffer(a);
  });

  it('leaves what it cannot or must not detach', () => {
    freeBuffer(null);
    freeBuffer(undefined);
    const mem = new WebAssembly.Memory({ initial: 1 });
    const view = new Uint8Array(mem.buffer);
    freeBuffer(view);
    expect(mem.buffer.byteLength).toBe(65536);
    const shared = new Int32Array(new SharedArrayBuffer(64));
    freeBuffer(shared);
    expect(shared.length).toBe(16);
  });
});
