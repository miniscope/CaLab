/**
 * cala's run file (`calab-run.json`, `docs/projects.md` "The run file"): one run, one config,
 * one library. Built from the run's sessions and its run record (`run-provenance.ts`), which is
 * folded in: the record's `params` block becomes `config`, its stages `stages`, its input
 * `inputs`, and the rest `record`. The same document is written into the run folder and, as it
 * is at that moment, into each export as `meta_json.run`.
 */
import { idSpaceOf, type RunFile, type RunPlanRef } from '@calab/project';
import { boundaryFlagJson } from './boundary-flags.ts';
import type { FrameSourceInfo } from './frame-source.ts';
import type { SessionRecord } from './session-export.ts';
import { CALA_PARAMS_VERSION } from '../params/schema.ts';

export const CALA_APP = 'cala';
/** The `config.schema` name of cala's params. */
export const CALA_PARAMS_SCHEMA_NAME = 'cala-params';
/** The artifact each written stream of a cala run holds. */
export const CALA_EXPORT_FILE = 'cala-export.npz';

/** One session of the run: its record and what probing it found. */
export interface RunFileSession {
  record: SessionRecord;
  /** The session's stream ref (relative to the data root). */
  stream: string;
  info:
    | (Pick<FrameSourceInfo, 'width' | 'height' | 'bitDepth' | 'fpsSource'> & {
        files?: readonly unknown[];
      })
    | null;
  /** What its export holds, once written. */
  written?: { cells: number; libraryVersion: number; created: string };
}

export interface CalaRunInput {
  id: string;
  /** The project's id (null outside a project). */
  project: string | null;
  plan: RunPlanRef | null;
  status: RunFile['run']['status'];
  stopped: string | null;
  created: string;
  updated: string;
  /** The app's version when the record has none (no run started yet). */
  version: string;
  sessions: readonly RunFileSession[];
  /** A Joint run: the sessions are one recording on one frame axis. */
  joint: boolean;
  /** The run record gathered now (null: none yet). */
  record: Record<string, unknown> | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strOr = (v: unknown, d: string | null): string | null => (typeof v === 'string' ? v : d);

/** The run file of a cala run. */
export function calaRunFile(i: CalaRunInput): RunFile {
  const rec = i.record ?? {};
  const software = isObj(rec.software) ? rec.software : {};
  const params = isObj(rec.params) ? rec.params : {};
  const {
    params: _params,
    stages,
    input: _input,
    software: _software,
    created: _created,
    ...record
  } = rec;
  const { requested, sources, values, fingerprint, ignored, ...paramsRest } = params;
  const live = isObj(rec.input) && rec.input.live === true;
  const fpsSource = (s: RunFileSession) => (live ? 'live' : (s.info?.fpsSource ?? 'none'));
  return {
    format: 'calab-run',
    version: 1,
    run: {
      id: i.id,
      app: CALA_APP,
      app_version: strOr(software.app_version, i.version)!,
      engine_version: strOr(software.engine_version, null),
      git_commit: strOr(software.git_commit, null),
      project: i.project,
      plan: i.plan,
      status: i.status,
      stopped: i.stopped,
      created: i.created,
      updated: i.updated,
    },
    inputs: i.sessions.map((s) => ({
      role: live ? 'live' : 'video',
      stream: s.stream,
      recording_start:
        s.record.recordingStartMs === null
          ? null
          : new Date(s.record.recordingStartMs).toISOString(),
      frames: s.record.frames,
      files: s.info?.files ? s.info.files.length : null,
      width: s.info?.width ?? null,
      height: s.info?.height ?? null,
      bit_depth: s.info?.bitDepth ?? null,
      fps: { value: s.record.fps, source: fpsSource(s) },
      start_frame: i.joint ? s.record.startFrame : 0,
    })),
    links: [],
    config: {
      schema: CALA_PARAMS_SCHEMA_NAME,
      params_version: CALA_PARAMS_VERSION,
      requested: isObj(requested) ? requested : {},
      sources: isObj(sources) ? (sources as Record<string, string>) : {},
      ignored: Array.isArray(ignored) ? ignored.filter((x) => typeof x === 'string') : [],
      resolved: isObj(values) ? values : {},
      fingerprint: typeof fingerprint === 'string' ? fingerprint : null,
    },
    derived:
      i.sessions.length > 0 && i.sessions[0].record.fps !== null
        ? {
            '/time/fps': {
              value: i.sessions[0].record.fps,
              source: 'data',
              method: fpsSource(i.sessions[0]),
              stream: 0,
            },
          }
        : {},
    frame: null,
    stages: Array.isArray(stages) ? (stages.filter(isObj) as RunFile['stages']) : [],
    results: i.sessions.map((s) => {
      const r = s.record;
      const start = i.joint ? r.startFrame : 0;
      return {
        stream: s.stream,
        status: r.status,
        ...(r.note ? { note: r.note } : {}),
        path:
          r.status === 'written'
            ? `${r.resultsPath === '.' || r.resultsPath === '' ? '' : `${r.resultsPath}/`}${CALA_EXPORT_FILE}`
            : null,
        id_space: idSpaceOf(CALA_APP, i.id),
        cells: s.written?.cells ?? null,
        library_version: s.written?.libraryVersion ?? null,
        frame_range: [start, start + r.frames],
        boundary: r.boundary ? boundaryFlagJson(r.boundary) : null,
        created: s.written?.created ?? null,
      };
    }),
    record: { ...record, params: paramsRest },
  };
}
