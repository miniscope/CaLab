import { describe, expect, it } from 'vitest';
import {
  chooseSeries,
  detectSeries,
  entriesForSeries,
  isBehaviourPrefix,
  numberingWarnings,
  seriesLabel,
  type NamedEntry,
} from '../lib/video-series.ts';

function entries(names: string[], dir = 'rec'): NamedEntry[] {
  return names.map((n) => ({ file: new File([''], n), relPath: dir ? `${dir}/${n}` : n }));
}
const seq = (prefix: string, from: number, to: number, ext = 'avi', pad = 0) =>
  Array.from(
    { length: to - from + 1 },
    (_, i) => `${prefix}${String(from + i).padStart(pad, '0')}.${ext}`,
  );
const names = (s: { files: { entry: NamedEntry }[] }) => s.files.map((f) => f.entry.file.name);

describe('detectSeries', () => {
  it('groups 0.avi..N as one empty-prefix series, sorted numerically', () => {
    const series = detectSeries(entries(['10.avi', '2.avi', '0.avi', '1.avi', 'notes.txt']));
    expect(series).toHaveLength(1);
    expect(series[0].prefix).toBe('');
    expect(names(series[0])).toEqual(['0.avi', '1.avi', '2.avi', '10.avi']);
    expect(seriesLabel(series[0])).toBe('<number>.avi');
  });

  it('reads msCam1..N and warns that numbering starts at 1', () => {
    const [s] = detectSeries(entries(seq('msCam', 1, 12)));
    expect(s.prefix).toBe('msCam');
    expect(s.files).toHaveLength(12);
    expect(seriesLabel(s)).toBe('msCam*.avi');
    expect(numberingWarnings(s)).toEqual(['The numbering starts at msCam1.avi, not msCam0.avi.']);
  });

  it('accepts _, - and space in prefixes and keeps them apart', () => {
    const series = detectSeries(
      entries([...seq('msCam_', 0, 1), ...seq('cam-', 0, 1), 'my cam0.avi']),
    );
    expect(series.map((s) => s.prefix).sort()).toEqual(['cam-', 'msCam_', 'my cam']);
  });

  it('sorts zero-padded names numerically and names gaps with the padding', () => {
    const [s] = detectSeries(
      entries(['msCam010.avi', 'msCam002.avi', 'msCam000.avi', 'msCam001.avi']),
    );
    expect(names(s)).toEqual(['msCam000.avi', 'msCam001.avi', 'msCam002.avi', 'msCam010.avi']);
    const w = numberingWarnings(s);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('Missing msCam003.avi, msCam004.avi');
  });

  it('warns about gaps with the real names', () => {
    const [s] = detectSeries(entries(['msCam0.avi', 'msCam1.avi', 'msCam4.avi']));
    expect(numberingWarnings(s)).toEqual(['Missing msCam2.avi, msCam3.avi in the numbering.']);
  });

  it('treats msCam1 and msCam01 as a duplicate number', () => {
    const [s] = detectSeries(entries(['msCam0.avi', 'msCam1.avi', 'msCam01.avi']));
    expect(s.files).toHaveLength(3);
    expect(numberingWarnings(s).join(' ')).toContain(
      'msCam1.avi and msCam01.avi have the same number',
    );
  });

  it('accepts an uppercase extension and mixes cases in one series', () => {
    const series = detectSeries(entries(['msCam0.AVI', 'msCam1.avi', 'msCam2.Avi']));
    expect(series).toHaveLength(1);
    expect(series[0].files).toHaveLength(3);
  });

  it('keeps series in different folders apart', () => {
    const series = detectSeries([
      ...entries(seq('', 0, 2), 'a/Miniscope'),
      ...entries(seq('', 0, 4), 'a/WebCam'),
    ]);
    expect(series.map((s) => s.dir).sort()).toEqual(['a/Miniscope', 'a/WebCam']);
  });

  it('finds nothing without a numbered .avi', () => {
    expect(detectSeries(entries(['notes.txt', 'clip.avi', 'a1.mp4']))).toEqual([]);
  });
});

describe('chooseSeries', () => {
  it('uses the only series', () => {
    const c = chooseSeries(detectSeries(entries(seq('weird_name', 0, 3))));
    expect(c.chosen?.prefix).toBe('weird_name');
  });

  it('returns no choice and no candidates for no match', () => {
    expect(chooseSeries([])).toEqual({ chosen: null, candidates: [] });
  });

  it('picks msCam over a behavCam series in the same folder', () => {
    const c = chooseSeries(
      detectSeries(entries([...seq('behavCam', 0, 5), ...seq('msCam', 0, 2)])),
    );
    expect(c.chosen?.prefix).toBe('msCam');
  });

  it('excludes behaviour prefixes case-insensitively', () => {
    for (const p of ['behavCam', 'BehavCam', 'behavior_', 'Behaviour-', 'behav']) {
      expect(isBehaviourPrefix(p)).toBe(true);
    }
    expect(isBehaviourPrefix('msCam')).toBe(false);
    const c = chooseSeries(detectSeries(entries([...seq('Behavior_', 0, 9), ...seq('cam', 0, 2)])));
    expect(c.chosen?.prefix).toBe('cam');
  });

  it('prefers the empty prefix over an unknown prefix, as in a V4 folder next to a webcam', () => {
    const c = chooseSeries(detectSeries(entries([...seq('', 0, 2), ...seq('webcam', 0, 9)])));
    expect(c.chosen?.prefix).toBe('');
  });

  it('prefers the miniscope folder when prefixes tie', () => {
    const c = chooseSeries(
      detectSeries([
        ...entries(seq('', 0, 2), 'session/My_V4_Miniscope'),
        ...entries(seq('', 0, 5), 'session/My_WebCam'),
      ]),
    );
    expect(c.chosen?.dir).toBe('session/My_V4_Miniscope');
  });

  it('returns the candidates, largest first, when two series are ambiguous', () => {
    const c = chooseSeries(detectSeries(entries([...seq('camA', 0, 2), ...seq('camB', 0, 5)])));
    expect(c.chosen).toBeNull();
    expect(c.candidates.map((s) => s.prefix)).toEqual(['camB', 'camA']);
  });

  it('is ambiguous across two session folders with the same names', () => {
    const c = chooseSeries(
      detectSeries([
        ...entries(seq('msCam', 0, 2), 'day1/rec'),
        ...entries(seq('msCam', 0, 2), 'day2/rec'),
      ]),
    );
    expect(c.chosen).toBeNull();
    expect(c.candidates.map((s) => s.dir)).toEqual(['day1/rec', 'day2/rec']);
  });

  it('falls back to the behaviour series when nothing else exists', () => {
    const c = chooseSeries(
      detectSeries(
        entries([
          ...seq('behavCam', 0, 2),
          ...seq('behavCam', 0, 1, 'avi', 2).map((n) => n.replace('behavCam', 'behavTop')),
        ]),
      ),
    );
    expect(c.candidates).toHaveLength(2);
  });

  it('finds msCam in nested folders next to a behaviour camera', () => {
    const c = chooseSeries(
      detectSeries([
        ...entries(seq('msCam', 0, 2), 'animal/day1/miniscope'),
        ...entries(seq('behavCam', 0, 4), 'animal/day1/behav'),
      ]),
    );
    expect(c.chosen?.dir).toBe('animal/day1/miniscope');
  });
});

describe('entriesForSeries', () => {
  it('drops the other series but keeps sidecars and unrelated files', () => {
    const all = entries([
      ...seq('camA', 0, 1),
      ...seq('camB', 0, 1),
      'metaData.json',
      'timeStamps.csv',
    ]);
    const series = detectSeries(all);
    const b = series.find((s) => s.prefix === 'camB')!;
    const out = entriesForSeries(all, series, b).map((e) => e.file.name);
    expect(out).toEqual(['camB0.avi', 'camB1.avi', 'metaData.json', 'timeStamps.csv']);
  });
});
