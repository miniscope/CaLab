/**
 * Drives a multi-session run (`session-run.ts`): opens the sessions, starts
 * Refine and Extract when they are due, writes each session's results
 * (`session-export.ts`) and, in Separate mode, moves on to the next session.
 *
 * The stores that run the stages stay as they are; this store only watches
 * them and calls their actions, through the narrow `MultiRunDeps`.
 */
import { createEffect, createSignal, on, untrack } from 'solid-js';
import type { ExportInput } from './export.ts';
import { writeCalaExport } from './export.ts';
import type { FrameSourceInfo } from './frame-source.ts';
import { sessionBoundaries } from './frame-source.ts';
import type { StageActivity, StageName, StageRun } from './run-stages.ts';
import {
  autoStatusText,
  nextAutoAction,
  type AutoAction,
  type RunSettings,
} from './session-run.ts';
import {
  exportSessionBlock,
  runManifest,
  RUN_MANIFEST_FILE,
  SESSION_EXPORT_FILE,
  SESSION_META_FILE,
  sessionMetadata,
  type ResultsSink,
  type SessionRecord,
} from './session-export.ts';
import type { SessionCandidate } from './sessions.ts';

/** A session in the list, with what probing it found. */
export interface PlannedSession {
  candidate: SessionCandidate;
  /** Its own info (frames, size, fps), or null while probing or on error. */
  info: FrameSourceInfo | null;
  error: string | null;
  /** `recordingStartTime` from metaData.json, ms since the epoch. */
  startMs: number | null;
  /** Its results folder below the run folder. */
  resultsPath: string;
}

export interface MultiRunPlan {
  sessions: PlannedSession[];
  settings: RunSettings;
  /** Opens the results location (asked for when the run starts); null after a failure. */
  openSink: () => Promise<ResultsSink>;
  /** For the panel: where results go. */
  locationLabel: string;
}

export interface MultiRunDeps {
  /** Joint: open every session as one recording and start Discover. */
  openJoint(sessions: PlannedSession[]): Promise<void>;
  /** Separate: open one session and start Discover. */
  openOne(session: PlannedSession, index: number): Promise<void>;
  stages(): {
    discover: StageActivity;
    refine: StageActivity;
    extract: StageActivity;
    availability: Record<StageName, string | null>;
    runs: readonly StageRun[];
  };
  runRefine(): void;
  runExtract(): void;
  /** The export of the current result, all frames (null: no result). */
  exportInput(): ExportInput | null;
  /** The open recording. */
  info(): FrameSourceInfo | null;
  version: string;
  now?: () => Date;
}

export function createMultiRun(deps: MultiRunDeps) {
  const now = deps.now ?? (() => new Date());
  const [plan, setPlan] = createSignal<MultiRunPlan | null>(null);
  const [current, setCurrent] = createSignal(0);
  const [exported, setExported] = createSignal(false);
  const [exporting, setExporting] = createSignal(false);
  const [records, setRecords] = createSignal<SessionRecord[]>([]);
  const [action, setAction] = createSignal<AutoAction>({ kind: 'wait' });
  const [error, setError] = createSignal<string | null>(null);
  const [root, setRoot] = createSignal<string | null>(null);
  const [finished, setFinished] = createSignal(false);
  let sink: ResultsSink | null = null;
  let createdAt = '';
  /** The last action started, so an effect re-run does not start it twice. */
  let dispatched = '';

  const active = () => plan() !== null;

  function recordsFor(p: MultiRunPlan): SessionRecord[] {
    let start = 0;
    return p.sessions.map((s, index) => {
      const frames = s.info?.frameCount ?? 0;
      const r: SessionRecord = {
        index,
        name: s.candidate.name,
        dir: s.candidate.dir,
        resultsPath: s.resultsPath,
        startFrame: p.settings.mode === 'joint' ? start : 0,
        frames,
        fps: s.info?.fps ?? null,
        recordingStartMs: s.startMs,
        status: 'pending',
      };
      start += frames;
      return r;
    });
  }

  function patchRecord(index: number, patch: Partial<SessionRecord>): void {
    setRecords(records().map((r) => (r.index === index ? { ...r, ...patch } : r)));
  }

  async function writeManifest(done: boolean): Promise<void> {
    const p = plan();
    if (!p || !sink) return;
    const info = deps.info();
    const text = JSON.stringify(
      runManifest({
        version: deps.version,
        settings: p.settings,
        sessions: records(),
        boundaries: p.settings.mode === 'joint' && info ? sessionBoundaries(info) : [],
        root: sink.root,
        createdAt,
        updatedAt: now().toISOString(),
        finished: done,
      }),
      null,
      2,
    );
    await sink.writeText(RUN_MANIFEST_FILE, text);
  }

  /** Write the results that are final now: one session (Separate) or all (Joint). */
  async function exportResults(): Promise<void> {
    const p = plan();
    const base = deps.exportInput();
    if (!p || !base) throw new Error('There is no Extract result to write.');
    if (!sink) {
      sink = await p.openSink();
      setRoot(sink.root);
    }
    const joint = p.settings.mode === 'joint';
    const info = deps.info();
    const boundaries = joint && info ? sessionBoundaries(info) : [];
    // Joint: the spans of the recording as opened are the authority.
    if (joint && info?.sessions)
      for (const span of info.sessions)
        patchRecord(span.index, { startFrame: span.startFrame, frames: span.frameCount });
    const which = joint ? records() : records().filter((r) => r.index === current());
    const runs = deps.stages().runs;
    for (const r of which) {
      const input: ExportInput = {
        ...base,
        label: r.name,
        fps: r.fps ?? base.fps,
        ...(joint ? { frameRange: { start: r.startFrame, end: r.startFrame + r.frames } } : {}),
        session: exportSessionBlock(r, p.settings.mode, p.sessions.length),
      };
      await sink.writeFile(`${r.resultsPath}/${SESSION_EXPORT_FILE}`, (s) =>
        writeCalaExport(input, s),
      );
      const meta = sessionMetadata({
        version: deps.version,
        settings: p.settings,
        session: r,
        sessions: p.sessions.length,
        boundaries,
        stages: runs,
        libraryVersion: base.result.version,
        cells: base.result.ids.length,
        sharedCellIds: joint ? Array.from(base.result.ids) : null,
        createdAt: now().toISOString(),
      });
      await sink.writeText(`${r.resultsPath}/${SESSION_META_FILE}`, JSON.stringify(meta, null, 2));
      patchRecord(r.index, { status: 'written' });
    }
    await writeManifest(false);
  }

  async function finish(skipped?: string): Promise<void> {
    if (skipped) patchRecord(current(), { status: 'skipped', note: skipped });
    if (!sink) {
      const p = plan();
      if (p) {
        sink = await p.openSink();
        setRoot(sink.root);
      }
    }
    await writeManifest(true);
    await sink?.finish();
    setFinished(true);
  }

  async function nextSession(skipped?: string): Promise<void> {
    const p = plan()!;
    if (skipped) patchRecord(current(), { status: 'skipped', note: skipped });
    const next = current() + 1;
    setCurrent(next);
    setExported(false);
    await deps.openOne(p.sessions[next], next);
  }

  /** Run `job` once for `key`; failures stop the automatic run with a message. */
  function dispatch(key: string, job: () => Promise<void> | void): void {
    if (dispatched === key) return;
    dispatched = key;
    void (async () => {
      try {
        await job();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }

  // The automatic run: one step whenever a stage's state changes.
  createEffect(() => {
    const p = plan();
    if (!p || finished() || error()) return;
    const st = deps.stages();
    const input = {
      settings: p.settings,
      discover: st.discover,
      refine: st.refine,
      extract: st.extract,
      refinesDone: st.runs.filter((r) => r.stage === 'refine' && r.outcome === 'done').length,
      availability: st.availability,
      exported: exported(),
      exporting: exporting(),
      session: current(),
      sessions: p.sessions.length,
    };
    const a = nextAutoAction(input);
    setAction(a);
    const key = `${current()}:${a.kind}:${input.refinesDone}:${st.runs.length}`;
    untrack(() => {
      switch (a.kind) {
        case 'refine':
          dispatch(key, deps.runRefine);
          break;
        case 'extract':
          dispatch(key, deps.runExtract);
          break;
        case 'export':
          dispatch(key, async () => {
            setExporting(true);
            try {
              await exportResults();
              setExported(true);
            } catch (err) {
              patchRecord(current(), { status: 'failed', note: String(err) });
              throw err;
            } finally {
              setExporting(false);
            }
          });
          break;
        case 'next-session':
          dispatch(key, () => nextSession(a.skipped));
          break;
        case 'finished':
          dispatch(key, () => finish(a.skipped));
          break;
      }
    });
  });
  // A new Extract result has not been written yet.
  createEffect(
    on(
      () => deps.stages().extract,
      (st) => {
        if (st === 'running') setExported(false);
      },
    ),
  );

  /** Start a run: Joint opens every session at once, Separate the first. */
  async function start(p: MultiRunPlan): Promise<void> {
    sink = null;
    dispatched = '';
    createdAt = now().toISOString();
    setRoot(null);
    setError(null);
    setFinished(false);
    setExported(false);
    setCurrent(0);
    setPlan(p);
    setRecords(recordsFor(p));
    if (p.settings.mode === 'joint') await deps.openJoint(p.sessions);
    else await deps.openOne(p.sessions[0], 0);
  }

  function stop(): void {
    setPlan(null);
    sink = null;
  }

  return {
    plan,
    active,
    current,
    records,
    action,
    statusText: () => {
      const p = plan();
      if (!p) return '';
      if (error()) return `Stopped: ${error()}`;
      if (finished()) return 'All sessions done; results written.';
      return autoStatusText(action(), { session: current(), sessions: p.sessions.length });
    },
    error,
    exporting,
    finished,
    /** The run folder's name once the first results are written. */
    root,
    start,
    stop,
  };
}

export type MultiRun = ReturnType<typeof createMultiRun>;
