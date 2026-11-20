import { describe, expect, it } from 'vitest';
import type { FolderEntry } from '../lib/frame-source.ts';
import {
  chooseKind,
  defaultOrder,
  discoverSessions,
  groupKinds,
  moveItem,
  parseRecordingStart,
  removeItem,
  runFolderName,
  sessionResultsPath,
  seriesKindKey,
  uniqueResultsPaths,
  validateSessions,
} from '../lib/sessions.ts';
import { detectSeries } from '../lib/video-series.ts';

function entries(names: string[], dir: string): FolderEntry[] {
  return names.map((n) => ({ file: new File([''], n), relPath: dir ? `${dir}/${n}` : n }));
}
const seq = (prefix: string, from: number, to: number, ext = 'avi') =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}.${ext}`);
const rel = (es: FolderEntry[]) => es.map((e) => e.relPath);

describe('discoverSessions: Miniscope V4 layout', () => {
  const v4 = (time: string) => {
    const base = `data/2026_11_10/${time}`;
    return [
      ...entries(['metaData.json'], base),
      ...entries([...seq('', 0, 2), 'metaData.json', 'timeStamps.csv'], `${base}/My_V4_Miniscope`),
      ...entries([...seq('', 0, 2), 'metaData.json', 'timeStamps.csv'], `${base}/BehavCam_0`),
    ];
  };
  const all = [...v4('14_02_33'), ...v4('15_10_00')];

  it('finds one session per time folder and excludes the behaviour camera', () => {
    const { sessions, kinds } = discoverSessions(all);
    expect(kinds).toHaveLength(2);
    expect(sessions?.map((s) => s.dir)).toEqual([
      'data/2026_11_10/14_02_33/My_V4_Miniscope',
      'data/2026_11_10/15_10_00/My_V4_Miniscope',
    ]);
    expect(sessions?.[0].name).toBe('2026_11_10/14_02_33/My_V4_Miniscope');
  });

  it('opens the series videos and the sidecars of its own directory only', () => {
    const s = discoverSessions(all).sessions![0];
    const dir = 'data/2026_11_10/14_02_33/My_V4_Miniscope';
    expect(rel(s.entries).sort()).toEqual(
      [0, 1, 2]
        .map((i) => `${dir}/${i}.avi`)
        .concat(`${dir}/metaData.json`, `${dir}/timeStamps.csv`)
        .sort(),
    );
  });

  it('lists metaData.json files nearest first, including the experiment-level one', () => {
    const s = discoverSessions(all).sessions![0];
    expect(rel(s.metaEntries)).toEqual([
      'data/2026_11_10/14_02_33/My_V4_Miniscope/metaData.json',
      'data/2026_11_10/14_02_33/metaData.json',
    ]);
  });
});

describe('discoverSessions: msCam layout', () => {
  it('finds one msCam session per day and ignores behavCam in the same directory', () => {
    const es = [
      ...entries([...seq('msCam', 1, 3), ...seq('behavCam', 1, 3), 'timestamp.dat'], 'mouse/day1'),
      ...entries([...seq('msCam', 1, 2), ...seq('behavCam', 1, 2)], 'mouse/day2'),
    ];
    const { sessions } = discoverSessions(es);
    expect(sessions?.map((s) => s.name)).toEqual(['day1', 'day2']);
    expect(sessions?.[0].entries).toHaveLength(3);
    expect(rel(sessions![1].entries).every((p) => /msCam/.test(p))).toBe(true);
  });
});

describe('discoverSessions: other shapes', () => {
  it('handles sessions at different depths when the device folder name matches', () => {
    const es = [
      ...entries(seq('', 0, 1), 'root/a/Miniscope'),
      ...entries(seq('', 0, 2), 'root/b/c/d/Miniscope'),
    ];
    const { sessions, kinds } = discoverSessions(es);
    expect(kinds).toHaveLength(1);
    expect(sessions?.map((s) => s.dir)).toEqual(['root/a/Miniscope', 'root/b/c/d/Miniscope']);
    expect(kinds[0].files).toBe(5);
    expect(kinds[0].label).toBe('Miniscope/<number>.avi');
  });

  it('one folder with one series is one session named after the folder', () => {
    const { sessions } = discoverSessions(entries(seq('', 0, 2), 'rec'));
    expect(sessions).toHaveLength(1);
    expect(sessions![0].name).toBe('rec');
    expect(sessions![0].metaEntries).toEqual([]);
  });

  it('names loose files "(selected files)"', () => {
    const { sessions } = discoverSessions(entries(seq('msCam', 1, 2), ''));
    expect(sessions).toHaveLength(1);
    expect(sessions![0].dir).toBe('');
    expect(sessions![0].name).toBe('(selected files)');
  });

  it('is ambiguous for two unrelated kinds in one directory, largest first', () => {
    const es = [...entries(seq('camA', 0, 1), 'rec'), ...entries(seq('camB', 0, 4), 'rec')];
    const { sessions, candidates } = discoverSessions(es);
    expect(sessions).toBeNull();
    expect(candidates.map((k) => k.label)).toEqual(['camB*.avi', 'camA*.avi']);
  });

  it('returns nothing for no videos', () => {
    const r = discoverSessions(entries(['notes.txt'], 'rec'));
    expect(r.sessions).toBeNull();
    expect(r.kinds).toEqual([]);
  });
});

describe('kinds', () => {
  it('keys by prefix, else by device folder name, case-insensitively', () => {
    const [a, b, c] = detectSeries([
      ...entries(['msCam1.avi'], 'x/y'),
      ...entries(['0.AVI'], 'x/My_Miniscope'),
      ...entries(['0.avi'], ''),
    ]);
    expect(seriesKindKey(a)).toBe('p:mscam:avi');
    expect(seriesKindKey(b)).toBe('d:my_miniscope:avi');
    expect(seriesKindKey(c)).toBe('d::avi');
  });

  it('prefers a miniscope-named device folder over an unrelated one', () => {
    const kinds = groupKinds(
      detectSeries([
        ...entries(seq('', 0, 5), 'r/Other'),
        ...entries(seq('', 0, 1), 'r/V4_Miniscope'),
      ]),
    );
    expect(chooseKind(kinds).chosen?.label).toBe('V4_Miniscope/<number>.avi');
  });

  it('keeps a behaviour kind when it is all there is', () => {
    const kinds = groupKinds(detectSeries(entries(seq('behavCam', 1, 2), 'r')));
    expect(chooseKind(kinds).chosen?.label).toBe('behavCam*.avi');
  });
});

describe('parseRecordingStart', () => {
  it('uses msecSinceEpoch when finite', () => {
    const t = { msecSinceEpoch: 946684800000, year: 2000, month: 1, day: 1 };
    expect(parseRecordingStart(JSON.stringify({ recordingStartTime: t }))).toBe(946684800000);
  });
  it('falls back to the date fields in local time, missing parts are 0', () => {
    const t = { year: 2026, month: 11, day: 10, hour: 14, minute: 2, second: 33, msec: 7 };
    expect(parseRecordingStart(JSON.stringify({ recordingStartTime: t }))).toBe(
      new Date(2026, 10, 10, 14, 2, 33, 7).getTime(),
    );
    expect(
      parseRecordingStart(JSON.stringify({ recordingStartTime: { year: 2026, month: 1, day: 2 } })),
    ).toBe(new Date(2026, 0, 2).getTime());
  });
  it('returns null for garbage', () => {
    expect(parseRecordingStart('not json')).toBeNull();
    expect(parseRecordingStart('{}')).toBeNull();
    expect(parseRecordingStart('null')).toBeNull();
    expect(
      parseRecordingStart('{"recordingStartTime": {"year": "x", "month": 1, "day": 1}}'),
    ).toBeNull();
    expect(parseRecordingStart('{"recordingStartTime": {"msecSinceEpoch": null}}')).toBeNull();
  });
});

describe('ordering helpers', () => {
  it('defaultOrder sorts by start time', () => {
    const items = [
      { dir: 'a', startMs: 30 },
      { dir: 'b', startMs: 10 },
      { dir: 'c', startMs: 20 },
    ];
    expect(defaultOrder(items).map((i) => i.dir)).toEqual(['b', 'c', 'a']);
    expect(items[0].dir).toBe('a');
  });
  it('defaultOrder falls back to natural path order when a time is missing', () => {
    const items = [
      { dir: 'r/day10', startMs: 1 },
      { dir: 'r/day2', startMs: null },
      { dir: 'r/day1', startMs: 3 },
    ];
    expect(defaultOrder(items).map((i) => i.dir)).toEqual(['r/day1', 'r/day2', 'r/day10']);
  });
  it('defaultOrder breaks time ties by natural dir', () => {
    const items = [
      { dir: 'day10', startMs: 5 },
      { dir: 'day2', startMs: 5 },
    ];
    expect(defaultOrder(items).map((i) => i.dir)).toEqual(['day2', 'day10']);
  });
  it('moveItem moves and clamps without mutating', () => {
    const a = [1, 2, 3, 4];
    expect(moveItem(a, 0, 2)).toEqual([2, 3, 1, 4]);
    expect(moveItem(a, 3, 0)).toEqual([4, 1, 2, 3]);
    expect(moveItem(a, 1, 99)).toEqual([1, 3, 4, 2]);
    expect(moveItem(a, 2, -5)).toEqual([3, 1, 2, 4]);
    expect(moveItem(a, 9, 0)).toEqual(a);
    expect(a).toEqual([1, 2, 3, 4]);
  });
  it('removeItem removes without mutating', () => {
    const a = ['x', 'y', 'z'];
    expect(removeItem(a, 1)).toEqual(['x', 'z']);
    expect(a).toHaveLength(3);
  });
});

describe('validateSessions', () => {
  const g = (name: string, w = 600, h = 600, bits = 8, fps: number | null = 30) => ({
    name,
    width: w,
    height: h,
    bitDepth: bits,
    fps,
  });
  it('is clean for an empty list or matching sessions', () => {
    expect(validateSessions([])).toEqual({ errors: [], warnings: [] });
    expect(validateSessions([g('day1'), g('day2')])).toEqual({ errors: [], warnings: [] });
  });
  it('errors on a resolution mismatch, naming both', () => {
    const r = validateSessions([g('day1'), g('day2', 600, 400, 16)]);
    expect(r.errors).toEqual([
      'day2 is 600x400 16-bit but day1 is 600x600 8-bit; all sessions must match.',
    ]);
  });
  it('errors on a bit depth mismatch', () => {
    const r = validateSessions([g('day1'), g('day2', 600, 600, 16)]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('16-bit');
  });
  it('warns on fps beyond the tolerance only', () => {
    expect(validateSessions([g('day1'), g('day2', 600, 600, 8, 20)]).warnings).toHaveLength(1);
    expect(validateSessions([g('day1'), g('day2', 600, 600, 8, 30.1)]).warnings).toEqual([]);
    expect(
      validateSessions([g('day1'), g('day2', 600, 600, 8, 30.1)], 0.001).warnings,
    ).toHaveLength(1);
  });
  it('warns when the frame rate is unknown', () => {
    const r = validateSessions([g('day1'), g('day2', 600, 600, 8, null)]);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('day2');
  });
});

describe('results paths', () => {
  it('mirrors the session folder without the root name', () => {
    expect(sessionResultsPath('data/2026_11_10/14_02_33/My_V4_Miniscope', 0)).toBe(
      '2026_11_10/14_02_33/My_V4_Miniscope',
    );
  });
  it('uses the root name for a root-level series and session-N for loose files', () => {
    expect(sessionResultsPath('rec', 3)).toBe('rec');
    expect(sessionResultsPath('', 1)).toBe('session-2');
  });
  it('sanitizes characters and dot segments', () => {
    expect(sessionResultsPath('root/../x', 0)).toBe('_/x');
    expect(sessionResultsPath('root/a:b/./c', 0)).toBe('a_b/_/c');
    expect(sessionResultsPath('root/Mouse 1 (left)', 0)).toBe('Mouse 1 _left_');
  });
  it('makes duplicates unique', () => {
    expect(uniqueResultsPaths(['r/a/Mini', 'q/a/Mini', 'p/a/Mini', 'r/b'])).toEqual([
      'a/Mini',
      'a/Mini_2',
      'a/Mini_3',
      'b',
    ]);
  });
});

describe('runFolderName', () => {
  const now = new Date(2026, 10, 13, 9, 5, 7);
  it('uses cala-results when free', () => {
    expect(runFolderName(new Set(['other']), now)).toBe('cala-results');
  });
  it('adds a local timestamp when taken', () => {
    expect(runFolderName(new Set(['cala-results']), now)).toBe('cala-results_2026-11-13_09-05-07');
  });
  it('adds _2 when the timestamped name is taken too', () => {
    const ex = new Set(['cala-results', 'cala-results_2026-11-13_09-05-07']);
    expect(runFolderName(ex, now)).toBe('cala-results_2026-11-13_09-05-07_2');
  });
});
