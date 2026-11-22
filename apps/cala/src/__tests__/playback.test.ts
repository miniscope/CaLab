import { describe, expect, it } from 'vitest';
import { PlaybackScheduler, playbackWanted } from '../lib/playback.ts';
import { downsampleFrame, downsampleFrames, framePreviewImage } from '../lib/preview.ts';

const batch = (start: number, n = 8) => Array.from({ length: n }, (_, i) => start + i);

/** Run the scheduler on a 60 Hz display for `ms`, feeding `arrivals` (time -> batch start). */
function run(
  s: PlaybackScheduler<number>,
  ms: number,
  arrivals: Map<number, number>,
  refreshMs = 1000 / 60,
): { t: number; frame: number }[] {
  const shown: { t: number; frame: number }[] = [];
  for (let t = 0; t <= ms; t += refreshMs) {
    for (const [at, start] of arrivals) {
      if (at <= t) {
        s.push(batch(start));
        arrivals.delete(at);
      }
    }
    const f = s.tick(t);
    if (f !== null) shown.push({ t, frame: f });
  }
  return shown;
}

describe('PlaybackScheduler', () => {
  it('shows frames evenly at the display rate, in order', () => {
    const s = new PlaybackScheduler<number>();
    s.setRate(30);
    const arrivals = new Map<number, number>();
    for (let k = 0; k < 6; k++) arrivals.set(k * (8000 / 30), k * 8);
    const shown = run(s, 1500, arrivals);
    const frames = shown.map((x) => x.frame);
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
    const gaps = shown.slice(1).map((x, i) => x.t - shown[i].t);
    console.log(gaps.map((g) => g.toFixed(1)).join(' '));
    // 30 fps on a 60 Hz display: every other refresh (a stall at a batch boundary may add one).
    for (const g of gaps) expect(g).toBeLessThan(1000 / 30 + 17);
    expect(gaps.filter((g) => Math.abs(g - 1000 / 30) < 2).length / gaps.length).toBeGreaterThan(
      0.8,
    );
    expect(s.dropped).toBe(0);
  });

  it('skips ahead when more than two batches are queued', () => {
    const s = new PlaybackScheduler<number>();
    s.setRate(30);
    for (let k = 0; k < 5; k++) s.push(batch(k * 8));
    expect(s.queued).toBeLessThanOrEqual(16);
    expect(s.dropped).toBeGreaterThan(0);
    // The newest frames survive.
    expect(s.flush()).toBe(39);
  });

  it('shows several due frames at once as the newest of them at a high rate', () => {
    const s = new PlaybackScheduler<number>();
    s.setRate(240);
    s.push(batch(0));
    expect(s.tick(0)).toBe(0);
    expect(s.tick(1000 / 60)).toBe(4); // 4 frames due in a 60 Hz refresh
  });

  it('does not burst after an empty queue', () => {
    const s = new PlaybackScheduler<number>();
    s.setRate(30);
    expect(s.tick(0)).toBeNull();
    expect(s.tick(5000)).toBeNull();
    s.push(batch(0));
    const first = s.tick(5016);
    expect(first === null || first <= 1).toBe(true);
    expect(s.queued).toBeGreaterThanOrEqual(6);
  });

  it('flush returns the newest frame and empties the queue; clear forgets', () => {
    const s = new PlaybackScheduler<number>();
    s.push(batch(0));
    s.push(batch(8));
    expect(s.flush()).toBe(15);
    expect(s.queued).toBe(0);
    expect(s.flush()).toBeNull();
    s.push(batch(16));
    s.clear();
    expect(s.queued).toBe(0);
    expect(s.dropped).toBe(0);
    expect(s.tick(10)).toBeNull();
  });

  it('ignores a bad rate', () => {
    const s = new PlaybackScheduler<number>();
    s.setRate(30);
    s.setRate(NaN);
    s.setRate(-5);
    s.push(batch(0));
    expect(s.tick(0)).toBe(0);
    expect(s.tick(34)).toBe(1);
  });
});

describe('PlaybackScheduler with a loop that stops on an empty queue', () => {
  it('does not credit the gap before a late batch', () => {
    const s = new PlaybackScheduler<number>();
    s.setRate(30);
    s.push(batch(0));
    // The store's loop: rAF at 60 Hz while frames are queued, none once the queue is empty.
    let t = 0;
    const shown: number[] = [];
    for (; s.queued > 0; t += 1000 / 60) {
      const f = s.tick(t);
      if (f !== null) shown.push(f);
    }
    expect(shown).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // The next batch arrives 300 ms late; no tick ran in between.
    t += 300;
    s.push(batch(8));
    const next: number[] = [];
    for (let k = 0; k < 4; k++, t += 1000 / 60) {
      const f = s.tick(t);
      if (f !== null) next.push(f);
    }
    // Frame 8 at once, then 9 a frame interval later: not 15 with 8-14 skipped.
    expect(next).toEqual([8, 9]);
    expect(s.dropped).toBe(0);
  });

  it('releases the consumed queue when it empties', () => {
    const s = new PlaybackScheduler<number>();
    s.setRate(1000);
    s.push(batch(0));
    expect(s.tick(0)).toBe(0);
    expect(s.tick(100)).toBe(7);
    expect(s.queued).toBe(0);
    // Internal arrays reset (memory): the next batch plays from its first frame.
    s.push(batch(8));
    expect(s.tick(200)).toBe(8);
  });
});

describe('playbackWanted', () => {
  it('has hysteresis', () => {
    expect(playbackWanted(30, false)).toBe(true);
    expect(playbackWanted(120, false)).toBe(false);
    expect(playbackWanted(120, true)).toBe(true);
    expect(playbackWanted(300, true)).toBe(false);
  });
});

describe('downsampleFrames', () => {
  it('matches downsampleFrame frame by frame', () => {
    const w = 7;
    const h = 5;
    const n = 4;
    const data = new Float32Array(w * h * n).map((_, i) => (i % 11 === 0 ? NaN : i * 0.5));
    const fp = downsampleFrames(data, n, w, h, 3, 'output', 40);
    expect(fp.first).toBe(40);
    expect(fp.count).toBe(n);
    for (let i = 0; i < n; i++) {
      const ref = downsampleFrame(data, i, w, h, 3);
      const got = framePreviewImage(fp, i);
      expect(got.width).toBe(ref.width);
      expect(Array.from(got.data)).toEqual(Array.from(ref.data));
    }
  });
});
