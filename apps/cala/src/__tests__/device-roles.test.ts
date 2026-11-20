import { describe, expect, it } from 'vitest';
import type { FolderEntry } from '../lib/frame-source.ts';
import {
  deviceFolderKey,
  deviceRoleFromMetadata,
  parseExperimentDevices,
  readDeviceRoles,
} from '../lib/device-roles.ts';
import { chooseKind, discoverKinds, discoverSessions, sessionsForKind } from '../lib/sessions.ts';
import { detectSeries } from '../lib/video-series.ts';

// The metaData.json files a Miniscope DAQ wrote for a V4 Miniscope and a Minicam
// behaviour camera (one real recording, trimmed to the fields that matter).
const SCOPE_META = JSON.stringify({
  compression: 'GREY',
  deviceName: 'img',
  deviceType: 'Miniscope_V4_BNO',
  ewl: -40,
  frameRate: '30FPS',
  framesPerFile: 1000,
  gain: 2,
  led0: 25,
});
const MINICAM_META = JSON.stringify({
  compression: 'MJPG',
  deviceName: 'behav',
  deviceType: 'Minicam-Mono-XGA',
  frameRate: '30FPS',
  framesPerFile: 1000,
  gain: '16X',
  led0: 0,
});
const experimentMeta = (miniscopes: string[], cameras: string[]) =>
  JSON.stringify({
    miniscopes,
    cameras,
    recordingStartTime: { msecSinceEpoch: 1735165833005 },
  });

type Tree = Record<string, string | null>;

/** A fake folder tree: path -> file text (null for an empty video). */
function tree(files: Tree): FolderEntry[] {
  return Object.entries(files).map(([relPath, text]) => ({
    relPath,
    file: new File([text ?? ''], relPath.slice(relPath.lastIndexOf('/') + 1)),
  }));
}
const avis = (dir: string, n = 3): Tree =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${dir}/${i}.avi`, null]));

async function sessionsOf(entries: FolderEntry[]) {
  const { chosen, candidates } = chooseKind(await discoverKinds(entries));
  return {
    chosen,
    candidates,
    dirs: chosen ? sessionsForKind(entries, chosen).map((s) => s.dir) : null,
  };
}

describe('metadata parsing', () => {
  it('reads the experiment device lists', () => {
    expect(parseExperimentDevices(experimentMeta(['img'], ['behav']))).toEqual({
      miniscopes: ['img'],
      cameras: ['behav'],
    });
    expect(parseExperimentDevices(JSON.stringify({ cameras: ['c'] }))).toEqual({
      miniscopes: [],
      cameras: ['c'],
    });
    expect(parseExperimentDevices(JSON.stringify({ researcherName: '' }))).toBeNull();
    expect(parseExperimentDevices('not json')).toBeNull();
  });

  it('tells a Miniscope from a Minicam by deviceType, not by gain or led0', () => {
    expect(deviceRoleFromMetadata(SCOPE_META)).toBe('miniscope');
    expect(deviceRoleFromMetadata(MINICAM_META)).toBe('camera');
    expect(deviceRoleFromMetadata(JSON.stringify({ deviceType: 'WebCam-640x480' }))).toBe('camera');
    expect(deviceRoleFromMetadata(JSON.stringify({ deviceType: 'Siminiscope' }))).toBe('miniscope');
    // No deviceType: an electrowetting lens is Miniscope-only; gain and led0 are on both.
    expect(deviceRoleFromMetadata(JSON.stringify({ ewl: 0, gain: 1 }))).toBe('miniscope');
    expect(deviceRoleFromMetadata(JSON.stringify({ gain: '16X', led0: 0 }))).toBeNull();
  });

  it('matches device names to folders with spaces as underscores', () => {
    expect(deviceFolderKey('My V4 Miniscope')).toBe('my_v4_miniscope');
  });
});

describe('Samara-style layout: img/ and behav/ listed in the experiment metaData.json', () => {
  const session = (t: string): Tree => ({
    [`Animal/${t}/metaData.json`]: experimentMeta(['img'], ['behav']),
    [`Animal/${t}/notes.csv`]: '',
    ...avis(`Animal/${t}/img`),
    [`Animal/${t}/img/metaData.json`]: SCOPE_META,
    [`Animal/${t}/img/timeStamps.csv`]: '',
    [`Animal/${t}/img/headOrientation.csv`]: '',
    ...avis(`Animal/${t}/behav`, 5),
    [`Animal/${t}/behav/metaData.json`]: MINICAM_META,
    [`Animal/${t}/behav/timeStamps.csv`]: '',
  });
  const entries = tree({ ...session('14_30_33'), ...session('14_44_22') });

  it('roles come from the experiment lists', async () => {
    const series = detectSeries(entries);
    const roles = await readDeviceRoles(entries, series);
    const byDir = Object.fromEntries(series.map((s) => [s.dir, roles.get(s.key)]));
    expect(byDir['Animal/14_30_33/img']).toEqual({ role: 'miniscope', source: 'experiment' });
    expect(byDir['Animal/14_30_33/behav']).toEqual({ role: 'camera', source: 'experiment' });
  });

  it('lists one session per recording, each the img folder', async () => {
    const { dirs } = await sessionsOf(entries);
    expect(dirs).toEqual(['Animal/14_30_33/img', 'Animal/14_44_22/img']);
  });

  it('picks img when one session folder is opened', async () => {
    const one = entries.filter((e) => e.relPath.startsWith('Animal/14_30_33/'));
    expect((await sessionsOf(one)).dirs).toEqual(['Animal/14_30_33/img']);
  });

  it('leaves out a camera whose folder name does not say so', async () => {
    const renamed = tree({
      'A/s1/metaData.json': experimentMeta(['img'], ['topview']),
      ...avis('A/s1/img'),
      ...avis('A/s1/topview', 9),
    });
    expect((await sessionsOf(renamed)).dirs).toEqual(['A/s1/img']);
    // Without metadata the same tree is ambiguous (before this change, too).
    expect(discoverSessions(renamed).sessions).toBeNull();
  });
});

describe('older naming: Miniscope/ and BehavCam_0/', () => {
  it('uses the device metaData.json when there are no experiment lists', async () => {
    const entries = tree({
      'm/day1/metaData.json': JSON.stringify({ recordingStartTime: { msecSinceEpoch: 1 } }),
      ...avis('m/day1/Miniscope'),
      'm/day1/Miniscope/metaData.json': JSON.stringify({ deviceType: 'Miniscope_V3', ewl: 0 }),
      ...avis('m/day1/BehavCam_0', 6),
      'm/day1/BehavCam_0/metaData.json': JSON.stringify({ deviceType: 'WebCam-640x480' }),
    });
    const kinds = await discoverKinds(entries);
    expect(kinds.find((k) => k.label.startsWith('BehavCam_0'))?.role).toEqual({
      role: 'camera',
      source: 'device',
    });
    expect((await sessionsOf(entries)).dirs).toEqual(['m/day1/Miniscope']);
  });

  it('a Miniscope folder renamed between days is still every session', async () => {
    const entries = tree({
      'm/d1/metaData.json': experimentMeta(['Miniscope'], ['BehavCam_0']),
      ...avis('m/d1/Miniscope'),
      ...avis('m/d1/BehavCam_0'),
      'm/d2/metaData.json': experimentMeta(['My V4 Miniscope'], ['BehavCam_0']),
      ...avis('m/d2/My_V4_Miniscope'),
      ...avis('m/d2/BehavCam_0'),
    });
    expect((await sessionsOf(entries)).dirs).toEqual(['m/d1/Miniscope', 'm/d2/My_V4_Miniscope']);
  });

  it('ignores a shared metaData.json when msCam and behavCam share a folder', async () => {
    const entries = tree({
      ...Object.fromEntries(['msCam1.avi', 'msCam2.avi'].map((n) => [`m/day1/${n}`, null])),
      ...Object.fromEntries(['behavCam1.avi', 'behavCam2.avi'].map((n) => [`m/day1/${n}`, null])),
      'm/day1/metaData.json': SCOPE_META,
    });
    const kinds = await discoverKinds(entries);
    expect(kinds.map((k) => [k.label, k.role?.source])).toEqual(
      expect.arrayContaining([
        ['msCam*.avi', undefined],
        ['behavCam*.avi', 'name'],
      ]),
    );
    const { chosen } = chooseKind(kinds);
    expect(chosen?.label).toBe('msCam*.avi');
  });
});

describe('no metadata', () => {
  it('falls back to the names as before and excludes nothing else', async () => {
    const entries = tree({ ...avis('a/s1/img'), ...avis('a/s1/behav'), ...avis('a/s2/img') });
    const kinds = await discoverKinds(entries);
    expect(kinds.find((k) => k.label.startsWith('behav'))?.role).toEqual({
      role: 'camera',
      source: 'name',
    });
    expect(kinds.find((k) => k.label.startsWith('img'))?.role).toBeNull();
    expect((await sessionsOf(entries)).dirs).toEqual(
      discoverSessions(entries).sessions!.map((s) => s.dir),
    );
  });

  it('two unknown device folders stay a question for the user', async () => {
    const entries = tree({ ...avis('a/s1/scopeA'), ...avis('a/s1/top', 5) });
    const { chosen, candidates } = await sessionsOf(entries);
    expect(chosen).toBeNull();
    expect(candidates.map((k) => k.label)).toEqual(['top/<number>.avi', 'scopeA/<number>.avi']);
  });

  it('a metadata-less folder is not read as a camera because a sibling has metadata', async () => {
    // One device says it is a Miniscope; the other has no metaData.json and no
    // telling name, so the metadata-confirmed Miniscope wins.
    const entries = tree({
      ...avis('a/s1/scope'),
      'a/s1/scope/metaData.json': SCOPE_META,
      ...avis('a/s1/other', 7),
    });
    expect((await sessionsOf(entries)).dirs).toEqual(['a/s1/scope']);
  });
});

describe('two Miniscopes in one session', () => {
  const entries = tree({
    'rig/s1/metaData.json': experimentMeta(['scopeL', 'scopeR'], ['behav']),
    ...avis('rig/s1/scopeL'),
    ...avis('rig/s1/scopeR'),
    ...avis('rig/s1/behav'),
    'rig/s2/metaData.json': experimentMeta(['scopeL', 'scopeR'], ['behav']),
    ...avis('rig/s2/scopeL'),
    ...avis('rig/s2/scopeR'),
    ...avis('rig/s2/behav'),
  });

  it('lists each Miniscope as its own stream, never the camera', async () => {
    const { chosen, dirs } = await sessionsOf(entries);
    expect(chosen?.role).toEqual({ role: 'miniscope', source: 'experiment' });
    expect(dirs).toEqual(['rig/s1/scopeL', 'rig/s1/scopeR', 'rig/s2/scopeL', 'rig/s2/scopeR']);
  });

  it('was a choice of one scope before (no metadata)', () => {
    expect(discoverSessions(entries).sessions).toBeNull();
  });
});
