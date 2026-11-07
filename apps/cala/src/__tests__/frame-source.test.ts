import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initCalaWasm } from '../lib/cala-wasm.ts';
import { FrameSource, HEADER_PREFIX_BYTES } from '../lib/frame-source.ts';
import { naturalCompare } from '../lib/natural-sort.ts';
import {
  fpsFromTimeStamps,
  parseFrameRate,
  parseMetadata,
  parseTimeStamps,
} from '../lib/miniscope-meta.ts';
import { buildAvi, expectedPixels, makeFile, type SynthOptions } from './synth-avi.ts';

beforeAll(async () => {
  const wasm = readFileSync(
    resolve(import.meta.dirname, '../../../../crates/cala/pkg/calab_cala_bg.wasm'),
  );
  await initCalaWasm(wasm);
});

const TS_HEADER = 'Frame Number,Time Stamp (ms),Buffer Index\n';

function timeStamps(n: number, intervalMs: number): string {
  let s = TS_HEADER;
  for (let i = 0; i < n; i++) s += `${i},${Math.round(i * intervalMs)},${i % 4}\n`;
  return s;
}

/** A recording of `counts.length` files, `0.avi`, `1.avi`, ..., in `dir`. */
function recording(counts: number[], base: Partial<SynthOptions> = {}, dir = 'rec') {
  const opts: SynthOptions[] = [];
  const files: File[] = [];
  let offset = 0;
  counts.forEach((frames, i) => {
    const o: SynthOptions = { width: 6, height: 4, frames, frameOffset: offset, ...base };
    opts.push(o);
    files.push(makeFile(`${i}.avi`, buildAvi(o), dir));
    offset += frames;
  });
  return { opts, files };
}

describe('naturalCompare', () => {
  it('orders numbered files numerically', () => {
    const names = ['10.avi', '2.avi', '1.avi', '9.avi', '0.avi', '11.avi'];
    expect(names.sort(naturalCompare)).toEqual([
      '0.avi',
      '1.avi',
      '2.avi',
      '9.avi',
      '10.avi',
      '11.avi',
    ]);
  });

  it('is stable for mixed names and padding', () => {
    expect(['b1', 'a10', 'a2'].sort(naturalCompare)).toEqual(['a2', 'a10', 'b1']);
    expect(naturalCompare('01.avi', '1.avi')).toBeGreaterThan(0);
    expect(naturalCompare('x', 'x')).toBe(0);
  });
});

describe('miniscope sidecars', () => {
  it('parses frame rates in the forms Miniscope writes', () => {
    expect(parseFrameRate('20FPS')).toBe(20);
    expect(parseFrameRate('30 fps')).toBe(30);
    expect(parseFrameRate(15.5)).toBe(15.5);
    expect(parseFrameRate('abc')).toBeNull();
    expect(parseFrameRate(0)).toBeNull();
    expect(parseFrameRate(undefined)).toBeNull();
  });

  it('parses metaData.json', () => {
    const m = parseMetadata(
      '{"frameRate":"20FPS","framesPerFile":1000,"deviceType":"Miniscope_V4_BNO"}',
    );
    expect(m).toEqual({ frameRate: 20, framesPerFile: 1000, deviceType: 'Miniscope_V4_BNO' });
    expect(parseMetadata('not json')).toBeNull();
    expect(parseMetadata('[1,2]')).toBeNull();
  });

  it('parses timeStamps.csv by header and derives fps from the mean interval', () => {
    const t = parseTimeStamps(timeStamps(100, 50));
    expect(t?.ms.length).toBe(100);
    expect(fpsFromTimeStamps(t!.ms)).toBeCloseTo(20, 6);
    // Time column found by name even when reordered, CRLF line endings.
    const re = parseTimeStamps('Buffer Index,Time Stamp (ms),Frame Number\r\n0,0,0\r\n1,33,1\r\n');
    expect(Array.from(re!.ms)).toEqual([0, 33]);
    expect(parseTimeStamps('a,b\n1,2\n')).toBeNull();
    expect(parseTimeStamps(TS_HEADER)).toBeNull();
  });

  it('ignores dropped-frame outliers in the mean', () => {
    const ms = Float64Array.from([0, 50, 100, 500, 550, 600, 650]);
    expect(fpsFromTimeStamps(ms)).toBeCloseTo(20, 6);
    // Integer-ms jitter: the mean (not a quantised median) gives 19.76 Hz.
    const jitter = Float64Array.from({ length: 1001 }, (_, i) => Math.round(i * 50.6));
    expect(fpsFromTimeStamps(jitter)).toBeCloseTo(1000 / 50.6, 1);
    expect(fpsFromTimeStamps(Float64Array.from([5]))).toBeNull();
    expect(fpsFromTimeStamps(Float64Array.from([5, 5, 5]))).toBeNull();
  });
});

describe('FrameSource', () => {
  it('stitches files into one global frame index', async () => {
    // Deliberately shuffled, and a 10th file to prove natural ordering.
    const { opts, files } = recording([3, 2, 4, 1, 2, 2, 1, 3, 2, 2, 5]);
    const shuffled = [...files].reverse();
    const src = await FrameSource.open(shuffled);
    expect(src.frameCount).toBe(27);
    expect([src.width, src.height]).toEqual([6, 4]);
    expect(src.info.files.map((f) => f.name).slice(8)).toEqual(['8.avi', '9.avi', '10.avi']);

    let g = 0;
    for (const o of opts) {
      for (let f = 0; f < o.frames; f++, g++) {
        const px = await src.readFrame(g);
        expect(px).toEqual(expectedPixels(o, f + (o.frameOffset ?? 0)));
      }
    }
    expect(g).toBe(27);
    src.dispose();
  });

  it('reads only the requested frame bytes, never a whole file', async () => {
    const { files } = recording([6, 6], { width: 40, height: 30 });
    const reads: number[] = [];
    for (const file of files) {
      const slice = file.slice.bind(file);
      file.slice = (start?: number, end?: number, type?: string) => {
        reads.push((end ?? file.size) - (start ?? 0));
        return slice(start, end, type);
      };
    }
    const src = await FrameSource.open(files);
    reads.length = 0;
    await src.readFrame(8);
    expect(reads).toEqual([8 + 40 * 30 + ((40 * 30) % 2)]);
    // Header reads are bounded by the prefix size plus the small idx1 region.
    expect(HEADER_PREFIX_BYTES).toBeGreaterThanOrEqual(64 * 1024);
  });

  it.each(['relative', 'absolute', 'none'] as const)('works with %s idx1', async (idx) => {
    const { opts, files } = recording([4, 3], { idx });
    const src = await FrameSource.open(files);
    expect(src.frameCount).toBe(7);
    expect(await src.readFrame(5)).toEqual(expectedPixels(opts[1], 5));
    if (idx === 'none') expect(src.info.warnings.join(' ')).toContain('no idx1');
  });

  it('returns frames in stored order despite biHeight > 0 and reports it', async () => {
    const { opts, files } = recording([2], { height: 5 });
    const src = await FrameSource.open(files);
    expect(src.info.bottomUp).toBe(true);
    expect(await src.readFrame(1)).toEqual(expectedPixels(opts[0], 1));
  });

  it('strips row padding (width 6 pads to 8)', async () => {
    const { files } = recording([1], { width: 6, height: 3 });
    const src = await FrameSource.open(files);
    expect((await src.readFrame(0)).length).toBe(18);
  });

  it('decodes 16-bit grayscale as byte pairs', async () => {
    const { opts, files } = recording([2], { fourcc: 'Y16 ', bitCount: 16, width: 5, height: 3 });
    const src = await FrameSource.open(files);
    expect(src.info.bitDepth).toBe(16);
    const px = await src.readFrame(1);
    expect(px.length).toBe(5 * 3 * 2);
    expect(px).toEqual(expectedPixels(opts[0], 1));
  });

  it('takes fps from timestamps, then metadata, never from the AVI header', async () => {
    const { files } = recording([5, 5], { usec: 16666 }); // header claims 60 fps
    const meta = makeFile('metaData.json', '{"frameRate":"20FPS","framesPerFile":5}', 'rec');
    const ts = makeFile('timeStamps.csv', timeStamps(10, 50), 'rec');

    const both = await FrameSource.open([...files, meta, ts]);
    expect(both.info.fpsSource).toBe('timestamps');
    expect(both.info.fps).toBeCloseTo(20, 6);
    expect(both.info.aviDeclaredFps).toBeCloseTo(60, 1);
    expect(both.info.warnings).toEqual([]);

    const metaOnly = await FrameSource.open([...files, meta]);
    expect(metaOnly.info.fpsSource).toBe('metadata');
    expect(metaOnly.info.fps).toBe(20);

    const neither = await FrameSource.open(files);
    expect(neither.info.fpsSource).toBe('none');
    expect(neither.info.fps).toBeNull();
    expect(neither.info.warnings.join(' ')).toContain('No frame rate');
  });

  it('finds prefixed sidecars (neural_*) and ignores behavior_* and camap copies', async () => {
    const { files } = recording([5]);
    const src = await FrameSource.open([
      ...files,
      makeFile('neural_metaData.json', '{"frameRate":"30FPS"}', 'rec'),
      makeFile('behavior_metaData.json', '{"frameRate":"99FPS"}', 'rec'),
      makeFile('neural_timestamp.csv', timeStamps(5, 50), 'rec'),
      makeFile('behavior_timestamp.csv', timeStamps(5, 10), 'rec'),
      makeFile('neural_timestamp_camap.csv', 'frame_index,timestamp_first\n0,0\n', 'rec'),
    ]);
    expect(src.info.fpsFromMetadata).toBe(30);
    expect(src.info.fpsFromTimestamps).toBeCloseTo(20, 6);
    expect(src.info.ignoredFiles.sort()).toEqual([
      'rec/behavior_metaData.json',
      'rec/behavior_timestamp.csv',
      'rec/neural_timestamp_camap.csv',
    ]);
  });

  it('warns when timestamps disagree with metadata or the frame count', async () => {
    const { files } = recording([5]);
    const src = await FrameSource.open([
      ...files,
      makeFile('metaData.json', '{"frameRate":"30FPS"}', 'rec'),
      makeFile('timeStamps.csv', timeStamps(8, 50), 'rec'),
    ]);
    const w = src.info.warnings.join(' | ');
    expect(w).toContain('using the timestamps');
    expect(w).toContain('8 rows but the videos have 5 frames');
    expect(src.info.timestampCount).toBe(8);
  });

  it('picks the miniscope folder when a parent holds several devices', async () => {
    const mini = recording([3], {}, 'session/My_V4_Miniscope');
    const cam = recording([5, 5], {}, 'session/My_WebCam');
    const src = await FrameSource.open([
      ...cam.files,
      ...mini.files,
      makeFile('metaData.json', '{"frameRate":"20FPS"}', 'session/My_V4_Miniscope'),
      makeFile('notes.txt', 'x', 'session'),
    ]);
    expect(src.frameCount).toBe(3);
    expect(src.info.fps).toBe(20);
    expect(src.info.ignoredFiles).toContain('session/My_WebCam/0.avi');
    expect(src.info.ignoredFiles).toContain('session/notes.txt');
  });

  it('rejects folders with no N.avi', async () => {
    await expect(FrameSource.open([makeFile('notes.txt', 'x')])).rejects.toThrow(
      /No Miniscope video/,
    );
    await expect(FrameSource.open([makeFile('clip.avi', new Uint8Array(4))])).rejects.toThrow(
      /No Miniscope video/,
    );
  });

  it('rejects compressed codecs with the file name and codec', async () => {
    const f = makeFile(
      '0.avi',
      buildAvi({ width: 8, height: 4, frames: 1, fourcc: 'MJPG', bitCount: 24 }),
    );
    await expect(FrameSource.open([f])).rejects.toThrow(/0\.avi: .*MJPG/);
  });

  it('rejects files that are not AVI', async () => {
    await expect(FrameSource.open([makeFile('0.avi', new Uint8Array(200))])).rejects.toThrow(
      /0\.avi: .*RIFF/,
    );
  });

  it('rejects files whose geometry disagrees', async () => {
    const a = makeFile('0.avi', buildAvi({ width: 8, height: 4, frames: 1 }));
    const b = makeFile('1.avi', buildAvi({ width: 9, height: 4, frames: 1 }));
    await expect(FrameSource.open([a, b])).rejects.toThrow(/all files must match/);
  });

  it('survives a truncated final file by dropping the cut frames', async () => {
    const o: SynthOptions = { width: 8, height: 4, frames: 5, idx: 'none' };
    const full = buildAvi(o);
    const cut = makeFile('0.avi', full.subarray(0, full.length - 40));
    const src = await FrameSource.open([cut]);
    expect(src.frameCount).toBe(4);
    expect(await src.readFrame(3)).toEqual(expectedPixels(o, 3));
  });

  it('rejects out-of-range and non-integer frame indices', async () => {
    const { files } = recording([2]);
    const src = await FrameSource.open(files);
    await expect(src.readFrame(2)).rejects.toThrow(RangeError);
    await expect(src.readFrame(-1)).rejects.toThrow(RangeError);
    await expect(src.readFrame(0.5)).rejects.toThrow(RangeError);
  });

  it('reads a header larger than the first prefix by retrying', async () => {
    // A huge JUNK-free header cannot be built cheaply; instead shrink the
    // first read by feeding a file whose header sits after >64 KB of JUNK.
    const base = buildAvi({ width: 8, height: 4, frames: 2, idx: 'none' });
    const junk = new Uint8Array(8 + 70_000);
    junk.set(new TextEncoder().encode('JUNK'), 0);
    new DataView(junk.buffer).setUint32(4, 70_000, true);
    // Insert the JUNK chunk right after the 12-byte RIFF header.
    const withJunk = new Uint8Array(base.length + junk.length);
    withJunk.set(base.subarray(0, 12), 0);
    withJunk.set(junk, 12);
    withJunk.set(base.subarray(12), 12 + junk.length);
    new DataView(withJunk.buffer).setUint32(4, withJunk.length - 8, true);
    const src = await FrameSource.open([makeFile('0.avi', withJunk)]);
    expect(src.frameCount).toBe(2);
    expect(await src.readFrame(1)).toEqual(expectedPixels({ width: 8, height: 4, frames: 2 }, 1));
  });
});
