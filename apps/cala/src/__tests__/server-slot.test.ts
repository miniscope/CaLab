import { describe, expect, it } from 'vitest';
import { ServerSlot } from '../lib/server-slot.ts';
import type { FrameServer } from '../lib/factor-reader.ts';

const fake = () => {
  const libs: number[] = [];
  const s: FrameServer = {
    setLibrary: (v) => void libs.push(v),
    serve: () => Promise.reject(new Error('unused')),
    dispose: () => {},
  };
  return { s, libs };
};

describe('ServerSlot', () => {
  it('hands the newest library to the server it switches to, and later ones to it only', () => {
    const a = fake();
    const b = fake();
    const slot = new ServerSlot(a.s);
    slot.setLibrary(3, new Uint8Array(1));
    slot.setLibrary(4, new Uint8Array(1));
    expect(slot.swap(b.s)).toBe(a.s);
    expect(slot.server).toBe(b.s);
    expect(b.libs).toEqual([4]);
    slot.setLibrary(5, new Uint8Array(1));
    expect(a.libs).toEqual([3, 4]);
    expect(b.libs).toEqual([4, 5]);
  });
  it('a switch before any library gives none', () => {
    const b = fake();
    new ServerSlot(fake().s).swap(b.s);
    expect(b.libs).toEqual([]);
  });
});
