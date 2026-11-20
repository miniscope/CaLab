/**
 * Which device folders are Miniscopes and which are cameras.
 *
 * Miniscope DAQ software writes one folder per recording with an
 * experiment-level `metaData.json` that lists its devices
 * (`"miniscopes": ["img"]`, `"cameras": ["behav"]`), and one subfolder per
 * device with its own `metaData.json` (`deviceType`: `Miniscope_V4_BNO`,
 * `Minicam-Mono-XGA`, `WebCam-640x480`, ...). A behaviour camera writes the
 * same numbered `.avi` files as a Miniscope, so the metadata is what tells
 * them apart:
 *
 *  1. The experiment-level lists (the device folder's name, spaces as `_`).
 *  2. Else the device's own `metaData.json`: a `deviceType` naming a Miniscope
 *     or a camera, else an `ewl` (electrowetting lens) field, which only a
 *     Miniscope has. `gain` and `led0` are not used: a Minicam writes both.
 *  3. Else the names (a `behav...` folder or prefix is a camera, a folder
 *     mentioning "miniscope" a Miniscope); nothing is excluded on a name
 *     alone beyond what `chooseKind` always did.
 *
 * A folder that holds several series (older DAQ software: `msCam*.avi` and
 * `behavCam*.avi` side by side) shares one metadata file between them, so only
 * the names count there.
 */
import type { FolderEntry } from './frame-source.ts';
import { dirOf, isBehaviourPrefix, type VideoSeries } from './video-series.ts';

export type DeviceRole = 'miniscope' | 'camera';
/** Where a role came from, strongest first. */
export type RoleSource = 'experiment' | 'device' | 'name';

export interface RoleInfo {
  role: DeviceRole;
  source: RoleSource;
}

export interface ExperimentDevices {
  miniscopes: string[];
  cameras: string[];
}

const METADATA_EXACT = /^metadata\.json$/i;
const METADATA_NAME = /(?:^|[_-])metadata\.json$/i;
const NEURAL_PREFIX = /^(?:neural|miniscope|ms)[_-]/i;
const MINISCOPE_TYPE = /miniscope/i;
const CAMERA_TYPE = /cam/i;
const BEHAVIOUR_DIR = /^behav/i;
const MINISCOPE_DIR = /miniscope/i;

function parseObject(text: string): Record<string, unknown> | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof json === 'object' && json !== null && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : null;
}

function basename(dir: string): string {
  const slash = dir.lastIndexOf('/');
  return slash < 0 ? dir : dir.slice(slash + 1);
}

/** A device name as its folder is named: trimmed, spaces as `_`, lower case. */
export function deviceFolderKey(name: string): string {
  return name.trim().replace(/\s+/g, '_').toLowerCase();
}

/** The `miniscopes` / `cameras` lists of an experiment-level metaData.json; null when it has neither. */
export function parseExperimentDevices(text: string): ExperimentDevices | null {
  const o = parseObject(text);
  if (!o) return null;
  const list = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  const miniscopes = list(o.miniscopes);
  const cameras = list(o.cameras);
  if (miniscopes === null && cameras === null) return null;
  return { miniscopes: miniscopes ?? [], cameras: cameras ?? [] };
}

/** What a device's own metaData.json says it is; null when it does not say. */
export function deviceRoleFromMetadata(text: string): DeviceRole | null {
  const o = parseObject(text);
  if (!o) return null;
  if (typeof o.deviceType === 'string') {
    if (MINISCOPE_TYPE.test(o.deviceType)) return 'miniscope';
    if (CAMERA_TYPE.test(o.deviceType)) return 'camera';
  }
  return 'ewl' in o ? 'miniscope' : null;
}

/** The role a series' names suggest (no metadata), or null. */
export function roleFromName(series: VideoSeries): DeviceRole | null {
  if (isBehaviourPrefix(series.prefix)) return 'camera';
  if (series.prefix !== '') return null;
  const name = basename(series.dir);
  if (BEHAVIOUR_DIR.test(name)) return 'camera';
  return MINISCOPE_DIR.test(name) ? 'miniscope' : null;
}

/**
 * The role of one series from its metadata texts (null when absent) and names.
 * `experimentText` is the metaData.json one folder up, `deviceText` the one in
 * the series' folder; `sharedDir` is true when other series share that folder.
 */
export function roleForSeries(
  series: VideoSeries,
  experimentText: string | null,
  deviceText: string | null,
  sharedDir: boolean,
): RoleInfo | null {
  if (!sharedDir && series.dir !== '') {
    const devices = experimentText === null ? null : parseExperimentDevices(experimentText);
    if (devices) {
      const key = deviceFolderKey(basename(series.dir));
      if (devices.miniscopes.some((n) => deviceFolderKey(n) === key)) {
        return { role: 'miniscope', source: 'experiment' };
      }
      if (devices.cameras.some((n) => deviceFolderKey(n) === key)) {
        return { role: 'camera', source: 'experiment' };
      }
    }
    const role = deviceText === null ? null : deviceRoleFromMetadata(deviceText);
    if (role) return { role, source: 'device' };
  }
  const named = roleFromName(series);
  return named ? { role: named, source: 'name' } : null;
}

/** The device metaData.json of a folder: the exact name, else one neural/miniscope-prefixed copy. */
function metadataIn(entries: FolderEntry[], dir: string): FolderEntry | undefined {
  const here = entries.filter((e) => dirOf(e.relPath) === dir && METADATA_NAME.test(e.file.name));
  const exact = here.find((e) => METADATA_EXACT.test(e.file.name));
  if (exact) return exact;
  const neural = here.filter((e) => NEURAL_PREFIX.test(e.file.name));
  if (neural.length === 1) return neural[0];
  return here.length === 1 ? here[0] : undefined;
}

/**
 * Read the metadata next to and above every series and give each a role
 * (keyed by `series.key`). Series with no role are absent. Only metaData.json
 * files are read; a file that cannot be read counts as absent.
 */
export async function readDeviceRoles(
  entries: FolderEntry[],
  series: VideoSeries<FolderEntry>[],
): Promise<Map<string, RoleInfo>> {
  const perDir = new Map<string, number>();
  for (const s of series) perDir.set(s.dir, (perDir.get(s.dir) ?? 0) + 1);
  const texts = new Map<string, Promise<string | null>>();
  const textOf = (dir: string, exactOnly: boolean): Promise<string | null> => {
    const key = `${exactOnly ? 'x' : 'd'}\u0000${dir}`;
    let p = texts.get(key);
    if (!p) {
      const entry = exactOnly
        ? entries.find((e) => dirOf(e.relPath) === dir && METADATA_EXACT.test(e.file.name))
        : metadataIn(entries, dir);
      p = entry ? entry.file.text().catch(() => null) : Promise.resolve(null);
      texts.set(key, p);
    }
    return p;
  };
  const out = new Map<string, RoleInfo>();
  await Promise.all(
    series.map(async (s) => {
      const shared = (perDir.get(s.dir) ?? 0) > 1;
      const parent = s.dir.includes('/') ? dirOf(s.dir) : null;
      const [experimentText, deviceText] =
        shared || s.dir === ''
          ? [null, null]
          : await Promise.all([
              parent === null ? null : textOf(parent, true),
              textOf(s.dir, false),
            ]);
      const info = roleForSeries(s, experimentText, deviceText, shared);
      if (info) out.set(s.key, info);
    }),
  );
  return out;
}

/** How a role reads in the series chooser. */
export function roleLabel(info: RoleInfo | null | undefined): string | null {
  if (!info) return null;
  const what = info.role === 'miniscope' ? 'Miniscope' : 'behaviour camera';
  return info.source === 'name' ? `looks like a ${what} (folder name)` : `${what} (metaData.json)`;
}
