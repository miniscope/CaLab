/**
 * The project model on plain data: ids, stream refs, a new project file and keeping its sessions
 * in line with a scan of the data folder. Pure; nothing here reads or writes a file.
 *
 * A **stream ref** names one device's data in one session, relative to the data root:
 * `<session id>/<stream id>`, e.g. `2026_11_10/09_00_00/My_V4_Miniscope`. The session id is the
 * recording folder (`.` for the root) and the stream id the device folder (`.` when the session
 * folder holds the videos itself).
 */
import type { ProjectFile, ProjectSession, ProjectStream } from './generated/files';
import { FORMATS, VERSIONS } from './formats.ts';

/** The ref of stream `stream` of session `session`. */
export function streamRef(session: string, stream: string): string {
  if (session === '.') return stream;
  if (stream === '.') return session;
  return `${session}/${stream}`;
}

/** A ref split into its session and stream ids (the stream is the last folder). */
export function splitStreamRef(ref: string): { session: string; stream: string } {
  const slash = ref.lastIndexOf('/');
  if (ref === '.' || ref === '') return { session: '.', stream: '.' };
  return slash < 0
    ? { session: '.', stream: ref }
    : { session: ref.slice(0, slash), stream: ref.slice(slash + 1) };
}

/** Every stream ref of a project, in its sessions' order. */
export function projectStreamRefs(p: Pick<ProjectFile, 'sessions'>): string[] {
  return p.sessions.flatMap((s) => s.streams.map((x) => streamRef(s.id, x.id)));
}

/** A new project id: `p-` and 8 hex digits. */
export function newProjectId(random: () => number = Math.random): string {
  let hex = '';
  for (let i = 0; i < 8; i++) hex += Math.floor(random() * 16).toString(16);
  return `p-${hex}`;
}

/** A run id: the local time and the app, `YYYY-MM-DD_HH-MM-SS_<app>`, unique among `taken`. */
export function runIdFor(now: Date, app: string, taken: ReadonlySet<string>): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const base =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}_${app}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

/** The id space of a run's own cell ids: results with the same id space share cell ids. */
export function idSpaceOf(app: string, runId: string): string {
  return `${app}:${runId}`;
}

/** A project file with no sessions, defaults or plan. */
export function emptyProject(name: string, now: Date, id: string = newProjectId()): ProjectFile {
  const t = now.toISOString();
  return {
    format: FORMATS.project,
    version: VERSIONS.project,
    project: { id, name, subject: { id: null, species: null, notes: '' }, created: t, updated: t },
    sessions: [],
    defaults: {},
    plan: { id: null, steps: [] },
    current: {},
    identity: [],
  };
}

/** A stream as a scan of the data folder found it. */
export interface ScannedStream {
  ref: string;
  role: string;
  /** `recordingStartTime`, ms since the epoch. */
  startMs: number | null;
  frames: number | null;
}

const isoMs = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

/** Same recording: the same start time and frame count, both known. */
function sameRecording(
  a: { start: string | null; frames: number | null },
  b: { startMs: number | null; frames: number | null },
): boolean {
  return (
    a.start !== null &&
    b.startMs !== null &&
    a.frames !== null &&
    b.frames !== null &&
    isoMs(a.start) === b.startMs &&
    a.frames === b.frames
  );
}

export interface Reconciled {
  project: ProjectFile;
  /** [old ref, new ref] of folders matched after a rename. */
  renamed: [string, string][];
  /** Refs whose folder is gone. */
  missing: string[];
  /** Refs new to the project. */
  added: string[];
}

interface FlatStream {
  ref: string;
  start: string | null;
  label: string | null;
  stream: ProjectStream;
}

/**
 * Bring a project's sessions in line with a scan. A known ref keeps its entry (frames
 * refreshed). A known stream whose folder is gone is matched to an unknown scanned one with the
 * same start time and frame count (exactly one candidate): a rename, so the old ref goes to
 * `previous_ids` and its results follow it. Else it stays (and is `missing`). Scanned streams
 * left over are added. Sessions come out in start-time order.
 */
export function reconcileStreams(
  project: ProjectFile,
  scanned: readonly ScannedStream[],
): Reconciled {
  const flat: FlatStream[] = project.sessions.flatMap((s) =>
    s.streams.map((x) => ({
      ref: streamRef(s.id, x.id),
      start: s.start,
      label: s.label,
      stream: x,
    })),
  );
  const known = new Set(flat.map((f) => f.ref));
  const scanRefs = new Set(scanned.map((s) => s.ref));
  const unknownScans = scanned.filter((s) => !known.has(s.ref));
  const renamed: [string, string][] = [];
  const missing: string[] = [];
  const claimed = new Set<string>();
  const renameTo = new Map<string, ScannedStream>();
  for (const f of flat) {
    if (scanRefs.has(f.ref)) continue;
    const probe = { start: f.start, frames: f.stream.frames };
    const cands = unknownScans.filter((u) => !claimed.has(u.ref) && sameRecording(probe, u));
    const othersWant = (u: ScannedStream) =>
      flat.some(
        (o) =>
          o !== f &&
          !scanRefs.has(o.ref) &&
          sameRecording({ start: o.start, frames: o.stream.frames }, u),
      );
    if (cands.length === 1 && !othersWant(cands[0])) {
      renameTo.set(f.ref, cands[0]);
      claimed.add(cands[0].ref);
      renamed.push([f.ref, cands[0].ref]);
    } else missing.push(f.ref);
  }
  const byRef = new Map(scanned.map((s) => [s.ref, s]));
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const out: FlatStream[] = flat.map((f) => {
    const scan = byRef.get(f.ref) ?? renameTo.get(f.ref);
    if (!scan) return f;
    const moved = scan.ref !== f.ref;
    return {
      ref: scan.ref,
      start: iso(scan.startMs) ?? f.start,
      label: f.label,
      stream: {
        ...f.stream,
        role: scan.role,
        frames: scan.frames ?? f.stream.frames,
        previous_ids: moved ? [...f.stream.previous_ids, f.ref] : f.stream.previous_ids,
      },
    };
  });
  const added = unknownScans.filter((u) => !claimed.has(u.ref));
  for (const u of added)
    out.push({
      ref: u.ref,
      start: iso(u.startMs),
      label: null,
      stream: {
        id: splitStreamRef(u.ref).stream,
        role: u.role,
        frames: u.frames,
        previous_ids: [],
      },
    });
  // Regroup by session id, in start-time order (unknown starts last, then by id).
  const sessions = new Map<string, ProjectSession>();
  for (const f of out) {
    const { session, stream } = splitStreamRef(f.ref);
    const s = sessions.get(session) ?? { id: session, start: f.start, label: f.label, streams: [] };
    if (s.start === null) s.start = f.start;
    s.streams.push({ ...f.stream, id: stream });
    sessions.set(session, s);
  }
  const list = [...sessions.values()].sort((a, b) => {
    const ta = isoMs(a.start);
    const tb = isoMs(b.start);
    if (ta !== null && tb !== null && ta !== tb) return ta - tb;
    if ((ta === null) !== (tb === null)) return ta === null ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return {
    project: { ...project, sessions: list },
    renamed,
    missing,
    added: added.map((u) => u.ref),
  };
}
