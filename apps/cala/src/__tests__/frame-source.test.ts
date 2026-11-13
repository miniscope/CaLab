import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initCalaWasm } from '../lib/cala-wasm.ts';
import {
  entriesFromFiles,
  FrameSource,
  HEADER_PREFIX_BYTES,
  MAX_FRAMES_PER_READ,
  OPEN_CONCURRENCY,
  mapLimit,
  sessionBoundaries,
  sessionOfFrame,
} from '../lib/frame-source.ts';
import { boundariesInBatch } from '../lib/session-boundary.ts';
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

const open = (files: File[]) => FrameSource.open(entriesFromFiles(files));

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
    const src = await open(shuffled);
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
    const src = await open(files);
    reads.length = 0;
    await src.readFrame(8);
    expect(reads).toEqual([8 + 40 * 30 + ((40 * 30) % 2)]);
    // Header reads are bounded by the prefix size plus the small idx1 region.
    expect(HEADER_PREFIX_BYTES).toBeGreaterThanOrEqual(64 * 1024);
  });

  it.each(['relative', 'absolute', 'none'] as const)('works with %s idx1', async (idx) => {
    const { opts, files } = recording([4, 3], { idx });
    const src = await open(files);
    expect(src.frameCount).toBe(7);
    expect(await src.readFrame(5)).toEqual(expectedPixels(opts[1], 5));
    if (idx === 'none') expect(src.info.warnings.join(' ')).toContain('no idx1');
  });

  it('returns frames in stored order despite biHeight > 0 and reports it', async () => {
    const { opts, files } = recording([2], { height: 5 });
    const src = await open(files);
    expect(src.info.bottomUp).toBe(true);
    expect(await src.readFrame(1)).toEqual(expectedPixels(opts[0], 1));
  });

  it('strips row padding (width 6 pads to 8)', async () => {
    const { files } = recording([1], { width: 6, height: 3 });
    const src = await open(files);
    expect((await src.readFrame(0)).length).toBe(18);
  });

  it('decodes 16-bit grayscale into a Uint16Array', async () => {
    const { opts, files } = recording([2], { fourcc: 'Y16 ', bitCount: 16, width: 5, height: 3 });
    const src = await open(files);
    expect(src.info.bitDepth).toBe(16);
    const px = await src.readFrame(1);
    expect(px).toBeInstanceOf(Uint16Array);
    expect(px.length).toBe(5 * 3);
    expect(new Uint8Array(px.buffer, px.byteOffset, px.byteLength)).toEqual(
      expectedPixels(opts[0], 1),
    );
  });

  it('takes fps from timestamps, then metadata, never from the AVI header', async () => {
    const { files } = recording([5, 5], { usec: 16666 }); // header claims 60 fps
    const meta = makeFile('metaData.json', '{"frameRate":"20FPS","framesPerFile":5}', 'rec');
    const ts = makeFile('timeStamps.csv', timeStamps(10, 50), 'rec');

    const both = await open([...files, meta, ts]);
    expect(both.info.fpsSource).toBe('timestamps');
    expect(both.info.fps).toBeCloseTo(20, 6);
    expect(both.info.aviDeclaredFps).toBeCloseTo(60, 1);
    expect(both.info.warnings).toEqual([]);

    const metaOnly = await open([...files, meta]);
    expect(metaOnly.info.fpsSource).toBe('metadata');
    expect(metaOnly.info.fps).toBe(20);

    const neither = await open(files);
    expect(neither.info.fpsSource).toBe('none');
    expect(neither.info.fps).toBeNull();
    expect(neither.info.warnings.join(' ')).toContain('No frame rate');
  });

  it('finds prefixed sidecars (neural_*) and ignores behavior_* and camap copies', async () => {
    const { files } = recording([5]);
    const src = await open([
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
    const src = await open([
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
    const src = await open([
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
    await expect(open([makeFile('notes.txt', 'x')])).rejects.toThrow(/No Miniscope video/);
  });

  it('rejects compressed codecs with the file name and codec', async () => {
    const f = makeFile(
      '0.avi',
      buildAvi({ width: 8, height: 4, frames: 1, fourcc: 'MJPG', bitCount: 24 }),
    );
    await expect(open([f])).rejects.toThrow(/0\.avi: .*MJPG/);
  });

  it('rejects files that are not AVI', async () => {
    await expect(open([makeFile('0.avi', new Uint8Array(200))])).rejects.toThrow(/0\.avi: .*RIFF/);
  });

  it('rejects files whose geometry disagrees', async () => {
    const a = makeFile('0.avi', buildAvi({ width: 8, height: 4, frames: 1 }));
    const b = makeFile('1.avi', buildAvi({ width: 9, height: 4, frames: 1 }));
    await expect(open([a, b])).rejects.toThrow(/all files must match/);
  });

  it('survives a truncated final file by dropping the cut frames', async () => {
    const o: SynthOptions = { width: 8, height: 4, frames: 5, idx: 'none' };
    const full = buildAvi(o);
    const cut = makeFile('0.avi', full.subarray(0, full.length - 40));
    const src = await open([cut]);
    expect(src.frameCount).toBe(4);
    expect(await src.readFrame(3)).toEqual(expectedPixels(o, 3));
  });

  it('rejects out-of-range and non-integer frame indices', async () => {
    const { files } = recording([2]);
    const src = await open(files);
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
    const src = await open([makeFile('0.avi', withJunk)]);
    expect(src.frameCount).toBe(2);
    expect(await src.readFrame(1)).toEqual(expectedPixels({ width: 8, height: 4, frames: 2 }, 1));
  });
});

describe('FrameSource batched reads', () => {
  /** Count the byte lengths of every slice taken from `files` from now on. */
  function trackSlices(files: File[]): number[] {
    const reads: number[] = [];
    for (const file of files) {
      const slice = file.slice.bind(file);
      file.slice = (start?: number, end?: number, type?: string) => {
        reads.push((end ?? file.size) - (start ?? 0));
        return slice(start, end, type);
      };
    }
    return reads;
  }

  it('reads a span across file boundaries with one slice per file', async () => {
    const { opts, files } = recording([4, 3, 5]);
    const reads = trackSlices(files);
    const src = await open(files);
    reads.length = 0;
    const px = await src.readFrames(2, 8); // 2 from file 0, 3 from file 1, 3 from file 2
    expect(reads).toHaveLength(3);
    const n = 6 * 4;
    expect(px.length).toBe(8 * n);
    let g = 2;
    for (let i = 0; i < 8; i++, g++) {
      const k = g < 4 ? 0 : g < 7 ? 1 : 2;
      const local = g - [0, 4, 7][k];
      expect(px.subarray(i * n, (i + 1) * n)).toEqual(
        expectedPixels(opts[k], local + (opts[k].frameOffset ?? 0)),
      );
    }
  });

  it('splits long runs at MAX_FRAMES_PER_READ', async () => {
    const { opts, files } = recording([70], { width: 4, height: 2 });
    const reads = trackSlices(files);
    const src = await open(files);
    reads.length = 0;
    const px = await src.readFrames(0, 70);
    expect(reads).toHaveLength(2);
    expect(reads[0]).toBe(MAX_FRAMES_PER_READ * (8 + 8));
    expect(px.subarray(69 * 8)).toEqual(expectedPixels(opts[0], 69));
  });

  it('decodes into a caller-provided buffer and validates it', async () => {
    const { opts, files } = recording([5]);
    const src = await open(files);
    const out = new Uint8Array(3 * 24);
    const res = await src.readFrames(1, 3, out);
    expect(res).toBe(out);
    expect(out.subarray(24, 48)).toEqual(expectedPixels(opts[0], 2));
    await expect(src.readFrames(1, 3, new Uint8Array(5))).rejects.toThrow(TypeError);
    await expect(src.readFrames(1, 3, new Uint16Array(72))).rejects.toThrow(TypeError);
    await expect(src.readFrames(3, 3)).rejects.toThrow(RangeError);
    await expect(src.readFrames(0, 0)).rejects.toThrow(RangeError);
  });

  it('matches readFrame frame for frame on 16-bit video', async () => {
    const { files } = recording([3, 3], { fourcc: 'Y16 ', bitCount: 16, width: 5, height: 3 });
    const src = await open(files);
    const batch = (await src.readFrames(1, 4)) as Uint16Array;
    expect(batch).toBeInstanceOf(Uint16Array);
    for (let i = 0; i < 4; i++) {
      expect(batch.subarray(i * 15, (i + 1) * 15)).toEqual(await src.readFrame(1 + i));
    }
  });
});

describe('FrameSource robustness', () => {
  it('lets idx1 decide when the first movi chunk is not a frame', async () => {
    for (const idx of ['relative', 'absolute'] as const) {
      const { opts, files } = recording([4], { junkInMovi: true, avihFrames: 0, idx });
      const src = await open(files);
      expect(src.frameCount).toBe(4);
      expect(await src.readFrame(3)).toEqual(expectedPixels(opts[0], 3));
    }
  });

  it('keeps a crash-truncated last file and drops one with no complete frame', async () => {
    const good = recording([3]);
    const crashed: SynthOptions = {
      width: 6,
      height: 4,
      frames: 5,
      idx: 'none',
      avihFrames: 0,
      zeroMoviSize: true,
      frameOffset: 3,
    };
    const full = buildAvi(crashed);
    const chunk = 8 + 32; // width 6 pads its rows to 8 bytes
    const cut = full.subarray(0, full.length - chunk - 7); // 3 whole frames + a partial one
    const empty = full.subarray(0, full.length - 5 * chunk + 10); // header + a stub
    const src = await open([
      ...good.files,
      makeFile('1.avi', cut, 'rec'),
      makeFile('2.avi', empty, 'rec'),
    ]);
    expect(src.frameCount).toBe(6);
    expect(src.info.files.map((f) => f.name)).toEqual(['0.avi', '1.avi']);
    expect(src.info.warnings.join(' ')).toContain('2.avi has no complete frames');
    expect(await src.readFrame(5)).toEqual(expectedPixels(crashed, 5));
  });

  it('warns about gaps and duplicates in the numbering', async () => {
    const { files } = recording([2, 2, 2], {}, 'rec');
    const gap = await open([
      files[0],
      files[1],
      makeFile('3.avi', buildAvi({ width: 6, height: 4, frames: 1 }), 'rec'),
    ]);
    expect(gap.info.warnings.join(' ')).toContain('Missing 2.avi');
    const dup = await open([
      files[0],
      makeFile('00.avi', buildAvi({ width: 6, height: 4, frames: 1 }), 'rec'),
    ]);
    expect(dup.info.warnings.join(' ')).toContain('0.avi and 00.avi have the same number');
    const late = await open([files[1]]);
    expect(late.info.warnings.join(' ')).toContain('starts at 1.avi');
  });
});

describe('read-ahead and throttled open', () => {
  it('mapLimit bounds concurrency, keeps order and stops after a failure', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([...Array(40).keys()], 5, async (i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return i * 2;
    });
    expect(peak).toBe(5);
    expect(out).toEqual([...Array(40).keys()].map((i) => i * 2));
    let started = 0;
    await expect(
      mapLimit([...Array(50).keys()], 2, async (i) => {
        started++;
        if (i === 3) throw new Error('boom');
        await new Promise((r) => setTimeout(r, 1));
      }),
    ).rejects.toThrow('boom');
    expect(started).toBeLessThan(50);
  });

  it('opens a many-file folder with bounded header reads and reports progress', async () => {
    const n = OPEN_CONCURRENCY * 3;
    const { files } = recording(Array<number>(n).fill(2));
    let active = 0;
    let peak = 0;
    for (const file of files) {
      const slice = file.slice.bind(file);
      file.slice = (start?: number, end?: number, type?: string) => {
        const blob = slice(start, end, type);
        const read = blob.arrayBuffer.bind(blob);
        blob.arrayBuffer = async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 1));
          const buf = await read();
          active--;
          return buf;
        };
        return blob;
      };
    }
    const progress: number[] = [];
    const src = await FrameSource.open(entriesFromFiles(files), {
      onProgress: (done) => progress.push(done),
    });
    expect(src.frameCount).toBe(2 * n);
    expect(peak).toBeLessThanOrEqual(OPEN_CONCURRENCY);
    expect(progress).toHaveLength(n);
    expect(progress[n - 1]).toBe(n);
  });

  it('reads the next batch ahead when reading sequentially, and returns the same pixels', async () => {
    const { opts, files } = recording([12]);
    const reads: number[] = [];
    for (const file of files) {
      const slice = file.slice.bind(file);
      file.slice = (start?: number, end?: number, type?: string) => {
        reads.push(start ?? 0);
        return slice(start, end, type);
      };
    }
    const src = await open(files);
    reads.length = 0;
    const n = 6 * 4;
    const a = await src.readFrames(0, 4);
    expect(reads).toHaveLength(1); // the first call has nothing to anticipate
    const b = await src.readFrames(4, 4);
    expect(reads).toHaveLength(3); // its own span, and frames 8..11 started ahead
    const c = await src.readFrames(8, 4);
    expect(reads).toHaveLength(3); // used the read-ahead; nothing past the end to fetch
    expect(a.subarray(0, n)).toEqual(expectedPixels(opts[0], 0));
    expect(b.subarray(3 * n)).toEqual(expectedPixels(opts[0], 7));
    expect(c.subarray(3 * n)).toEqual(expectedPixels(opts[0], 11));
    // A jump away from the sequence does not read ahead.
    reads.length = 0;
    await src.readFrames(1, 2);
    expect(reads).toHaveLength(1);
  });
});

describe('FrameSource: file naming', () => {
  /** Files `<prefix>0..n-1.avi` of 2 frames each, in `dir`. */
  function named(prefix: string, n: number, dir = 'rec', pad = 0, from = 0) {
    return Array.from({ length: n }, (_, i) =>
      makeFile(
        `${prefix}${String(from + i).padStart(pad, '0')}.avi`,
        buildAvi({ width: 6, height: 4, frames: 2, frameOffset: i * 2 }),
        dir,
      ),
    );
  }

  it('opens msCam0..N with its sidecars', async () => {
    const src = await open([
      ...named('msCam', 3),
      makeFile('timeStamps.csv', timeStamps(6, 50), 'rec'),
    ]);
    expect(src.frameCount).toBe(6);
    expect(src.info.files.map((f) => f.name)).toEqual(['msCam0.avi', 'msCam1.avi', 'msCam2.avi']);
    expect(src.info.fps).toBeCloseTo(20, 5);
  });

  it('opens msCam1..N with the numbering warning', async () => {
    const src = await open(named('msCam', 3, 'rec', 0, 1));
    expect(src.frameCount).toBe(6);
    expect(src.info.warnings.join(' ')).toContain('starts at msCam1.avi, not msCam0.avi');
  });

  it('opens zero-padded names in numeric order', async () => {
    const src = await open(named('msCam', 12, 'rec', 3).reverse());
    expect(src.info.files[0].name).toBe('msCam000.avi');
    expect(src.info.files[11].name).toBe('msCam011.avi');
  });

  it('auto-picks msCam next to a behavCam series and reads the sidecars beside it', async () => {
    const src = await open([
      ...named('behavCam', 5),
      ...named('msCam', 2),
      makeFile('metaData.json', '{"frameRate":"20FPS"}', 'rec'),
    ]);
    expect(src.frameCount).toBe(4);
    expect(src.info.fps).toBe(20);
    expect(src.info.ignoredFiles).toContain('rec/behavCam0.avi');
  });

  it('takes sidecars from the directory of the chosen series in nested folders', async () => {
    const src = await open([
      ...named('msCam', 2, 'a/miniscope'),
      makeFile('metaData.json', '{"frameRate":"30FPS"}', 'a/miniscope'),
      ...named('behavCam', 2, 'a/behav'),
      makeFile('metaData.json', '{"frameRate":"10FPS"}', 'a/behav'),
    ]);
    expect(src.info.fps).toBe(30);
  });

  it('opens individually picked files that are not numbered, in natural order', async () => {
    const mk = (name: string, offset: number) =>
      makeFile(name, buildAvi({ width: 6, height: 4, frames: 2, frameOffset: offset }));
    const src = await open([mk('clip 10.avi', 4), mk('clip 2.avi', 2), mk('clip 1.avi', 0)]);
    expect(src.info.files.map((f) => f.name)).toEqual(['clip 1.avi', 'clip 2.avi', 'clip 10.avi']);
  });

  it('still rejects a folder whose videos are not numbered', async () => {
    await expect(open([makeFile('clip.avi', new Uint8Array(4), 'rec')])).rejects.toThrow(
      /numbered \.avi files such as 0\.avi, 1\.avi/,
    );
  });
});

describe('FrameSource.openSessions', () => {
  const session = (name: string, files: File[]) => ({
    name,
    dir: `data/${name}`,
    entries: entriesFromFiles(files),
  });

  it('concatenates sessions in order and records where each starts', async () => {
    const a = recording([3, 2], {}, 'data/day1');
    const b = recording([4], {}, 'data/day2');
    const src = await FrameSource.openSessions([
      session('day1', [...a.files, makeFile('timeStamps.csv', timeStamps(5, 50), 'data/day1')]),
      session('day2', b.files),
    ]);
    expect(src.frameCount).toBe(9);
    expect(src.info.sessions).toEqual([
      { index: 0, name: 'day1', dir: 'data/day1', startFrame: 0, frameCount: 5, fps: 20, files: 2 },
      {
        index: 1,
        name: 'day2',
        dir: 'data/day2',
        startFrame: 5,
        frameCount: 4,
        fps: null,
        files: 1,
      },
    ]);
    expect(sessionBoundaries(src.info)).toEqual([5]);
    expect(sessionOfFrame(src.info, 4)).toBe(0);
    expect(sessionOfFrame(src.info, 5)).toBe(1);
    // Frame 5 is day2's first frame.
    expect(Array.from(await src.readFrame(5))).toEqual(Array.from(expectedPixels(b.opts[0], 0)));
    // A read across the boundary.
    const two = await src.readFrames(4, 2);
    expect(two.length).toBe(2 * 6 * 4);
    // Warnings name their session.
    expect(src.info.warnings.some((w) => w.startsWith('day2: No frame rate'))).toBe(true);
    src.dispose();
  });

  it('refuses sessions whose resolution differs', async () => {
    const a = recording([2], {}, 'data/day1');
    const b = recording([2], { width: 8 }, 'data/day2');
    await expect(
      FrameSource.openSessions([session('day1', a.files), session('day2', b.files)]),
    ).rejects.toThrow(/day2 is 8x4 8-bit but day1 is 6x4 8-bit/);
  });

  it('one session opens as a plain folder does, plus its span', async () => {
    const a = recording([3], {}, 'data/day1');
    const plain = await FrameSource.open(entriesFromFiles(a.files));
    const one = await FrameSource.openSessions([session('day1', a.files)]);
    const { sessions, ...rest } = one.info;
    expect(rest).toEqual(plain.info);
    expect(sessions).toHaveLength(1);
    expect(sessionBoundaries(one.info)).toEqual([]);
    plain.dispose();
    one.dispose();
  });
});

describe('boundariesInBatch', () => {
  it('finds the boundaries inside a batch only', () => {
    expect(boundariesInBatch([100, 250], 96, 8)).toEqual([{ index: 1, frame: 100 }]);
    expect(boundariesInBatch([100, 250], 100, 8)).toEqual([{ index: 1, frame: 100 }]);
    expect(boundariesInBatch([100, 250], 92, 8)).toEqual([]);
    expect(boundariesInBatch([100, 104], 96, 16)).toEqual([
      { index: 1, frame: 100 },
      { index: 2, frame: 104 },
    ]);
  });
});
