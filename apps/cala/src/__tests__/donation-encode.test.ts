// @vitest-environment node
// Node's own Blob/File (sliceable, with arrayBuffer) and CompressionStream.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeCalarawChunk, type CalarawChunk } from '@calab/io';
import { initCalaWasm } from '../lib/cala-wasm.ts';
import {
  bytesPerPixelFor,
  DonationCancelled,
  encodeRecording,
  sequentialFrames,
} from '../lib/donation-encode.ts';
import { entriesFromFiles, FrameSource, recordingSidecars } from '../lib/frame-source.ts';
import { baseName, buildMetaJson } from '../lib/donation-runner.ts';
import { buildAvi, makeFile, type SynthOptions } from './synth-avi.ts';

beforeAll(async () => {
  const wasm = readFileSync(
    resolve(import.meta.dirname, '../../../../crates/cala/pkg/calab_cala_bg.wasm'),
  );
  await initCalaWasm(wasm);
});

/** A two-file recording in folder `rec`, with a timeStamps.csv. */
function recording(o: Omit<SynthOptions, 'frames'>, frames: [number, number]): File[] {
  return [
    makeFile('0.avi', buildAvi({ ...o, frames: frames[0] }), 'rec'),
    makeFile('1.avi', buildAvi({ ...o, frames: frames[1], frameOffset: frames[0] }), 'rec'),
    makeFile('timeStamps.csv', 'Frame Number,Time Stamp (ms),Buffer Index\n0,0,0\n', 'rec'),
  ];
}

async function encodeAll(source: FrameSource, chunkBytes: number) {
  const chunks: CalarawChunk[] = [];
  const n = await encodeRecording(source, source.info, 20, {
    chunkBytes,
    span: 3,
    onChunk: async (c) => void chunks.push(c),
  });
  return { n, chunks };
}

describe('donation encoding', () => {
  it('round-trips an 8-bit recording frame for frame over several chunks', async () => {
    const files = recording({ width: 6, height: 4 }, [5, 4]);
    const source = await FrameSource.open(entriesFromFiles(files));
    const { n, chunks } = await encodeAll(source, 6 * 4 * 2); // 2 frames per chunk
    expect(n).toBe(5);
    expect(chunks.map((c) => [c.firstFrame, c.frames])).toEqual([
      [0, 2],
      [2, 2],
      [4, 2],
      [6, 2],
      [8, 1],
    ]);
    const expected = await source.readFrames(0, 9);
    let at = 0;
    for (const c of chunks) {
      const { header, frames } = await decodeCalarawChunk(c.bytes as Uint8Array<ArrayBuffer>);
      expect(header).toMatchObject({ width: 6, height: 4, totalFrames: 9, bytesPerPixel: 1 });
      expect(header.predictor).toBe(1);
      expect(header.fps).toBe(20);
      for (const f of frames) {
        expect(f).toBeInstanceOf(Uint8Array);
        expect(Array.from(f)).toEqual(Array.from(expected.subarray(at * 24, (at + 1) * 24)));
        at++;
      }
    }
    expect(at).toBe(9);
    source.dispose();
  });

  it('stores 16-bit video as 2 bytes per pixel, exactly as read', async () => {
    const files = recording({ width: 5, height: 3, fourcc: 'Y16 ', bitCount: 16 }, [3, 2]);
    const source = await FrameSource.open(entriesFromFiles(files));
    expect(source.info.bitDepth).toBe(16);
    const { chunks } = await encodeAll(source, 1 << 20);
    expect(chunks).toHaveLength(1);
    const { header, frames } = await decodeCalarawChunk(chunks[0].bytes as Uint8Array<ArrayBuffer>);
    expect(header.bytesPerPixel).toBe(2);
    const expected = (await source.readFrames(0, 5)) as Uint16Array;
    expect(frames).toHaveLength(5);
    frames.forEach((f, t) => {
      expect(f).toBeInstanceOf(Uint16Array);
      expect(Array.from(f)).toEqual(Array.from(expected.subarray(t * 15, (t + 1) * 15)));
    });
    source.dispose();
  });

  it('stops with DonationCancelled when cancelled', async () => {
    const files = recording({ width: 6, height: 4 }, [5, 4]);
    const source = await FrameSource.open(entriesFromFiles(files));
    let chunks = 0;
    await expect(
      encodeRecording(source, source.info, 20, {
        chunkBytes: 24,
        span: 1,
        cancelled: () => chunks >= 2,
        onChunk: async () => void chunks++,
      }),
    ).rejects.toBeInstanceOf(DonationCancelled);
    expect(chunks).toBe(2);
    source.dispose();
  });

  it('reads at most MAX_FRAMES_PER_READ frames per call', async () => {
    const calls: [number, number][] = [];
    const reader = {
      readFrames: async (start: number, count: number) => {
        calls.push([start, count]);
        return new Uint8Array(count * 4);
      },
    };
    const g = { width: 2, height: 2, frameCount: 150, bitDepth: 8 };
    let frames = 0;
    for await (const f of sequentialFrames(reader, g, { span: 1000 })) {
      expect(f.length).toBe(4);
      frames++;
    }
    expect(frames).toBe(150);
    expect(calls).toEqual([
      [0, 64],
      [64, 64],
      [128, 22],
    ]);
  });

  it('refuses bit depths other than 8 and 16', () => {
    expect(bytesPerPixelFor(8)).toBe(1);
    expect(bytesPerPixelFor(16)).toBe(2);
    expect(() => bytesPerPixelFor(12)).toThrow(/8 or 16/);
  });

  it('finds the timeStamps.csv the frame source uses', () => {
    const files = recording({ width: 6, height: 4 }, [1, 1]);
    const { timeStamps } = recordingSidecars(entriesFromFiles(files));
    expect(timeStamps?.name).toBe('timeStamps.csv');
  });

  it('meta.json carries base names only, never folders', async () => {
    const files = recording({ width: 6, height: 4 }, [2, 2]);
    const source = await FrameSource.open(entriesFromFiles(files));
    const info = {
      ...source.info,
      files: source.info.files.map((f) => ({ ...f, name: `/Users/someone/data/${f.name}` })),
    };
    const doc = JSON.parse(new TextDecoder().decode(buildMetaJson(info, '1.2.3', 20, 'public')));
    expect(doc.cala_version).toBe('1.2.3');
    expect(doc.sharing).toBe('public');
    expect(doc.source_files).toEqual([
      { name: '0.avi', frames: 2 },
      { name: '1.avi', frames: 2 },
    ]);
    expect(doc.frame_source).toMatchObject({ width: 6, height: 4, bitDepth: 8, frameCount: 4 });
    expect(JSON.stringify(doc)).not.toContain('/Users');
    expect(baseName('C:\\data\\rec\\0.avi')).toBe('0.avi');
    source.dispose();
  });
});
