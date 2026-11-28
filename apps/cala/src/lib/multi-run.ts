/**
 * Drives a multi-session run (`session-run.ts`): opens the sessions, starts
 * Extract when it is due, writes each session's results and the run file
 * (`run-file.ts`) and, in Separate mode, moves on to the next session.
 *
 * One library per run: a Joint chain is one run (one run folder, one
 * `calab-run.json`, one result per session); Separate sessions are one run
 * each. A run's file is written before its first frame (`beforeFrames`), after
 * each export, and when the run finishes or stops.
 *
 * The stores that run the stages stay as they are; this store only watches
 * them and calls their actions, through the narrow `MultiRunDeps`.
 */
import type { BoundaryFlag } from './boundary-flags.ts';
import { batch, createEffect, createSignal, on, untrack } from 'solid-js';
import type { ExportInput } from './export.ts';
import { writeCalaExport } from './export.ts';
import type { FrameSourceInfo } from './frame-source.ts';
import type { QcSnapshot } from './qc.ts';
import { fileText, RUN_FILE, type RunFile, type RunPlanRef } from '@calab/project';
import { calaRunFile, CALA_EXPORT_FILE, type RunFileSession } from './run-file.ts';
import type { StageActivity, StageName, StageRun } from './run-stages.ts';
import {
  autoStatusText,
  nextAutoAction,
  type AutoAction,
  type RunSettings,
} from './session-run.ts';
import { exportSessionBlock, type ResultsSink, type SessionRecord } from './session-export.ts';
import type { SessionCandidate } from './sessions.ts';
import { errMsg } from './errors.ts';

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
  /** Its stream ref, relative to the data root (`docs/projects.md`). */
  stream: string;
}

/** A run's folder, opened for writing. */
export interface OpenedRun {
  id: string;
  sink: ResultsSink;
  /** The run folder relative to the project folder (`runs/<id>`). */
  folder: string;
  /** The project's id, written into the run file. */
  project: string | null;
}

export interface MultiRunPlan {
  sessions: PlannedSession[];
  settings: RunSettings;
  /**
   * Opens the folder of run `index` (Joint: one run, 0; Separate: one per session), when that
   * run starts. Write permission is already granted.
   */
  openRun: (index: number) => Promise<OpenedRun>;
  /** The plan step run `index` was made for (null: none). */
  planRef?: (index: number) => RunPlanRef | null;
  /** For the panel: where results go. */
  locationLabel: string;
  /**
   * Told each time a run file is written: before the first frame, after each export, and when
   * the run finishes or stops. The project updates its index here. Failures are reported, never
   * stop the run.
   */
  onProgress?: (p: RunProgress) => Promise<void>;
}

/** What `onProgress` is told. */
export interface RunProgress {
  /** The run file as just written. */
  run: RunFile;
  /** Its folder relative to the project folder. */
  folder: string;
  sink: ResultsSink;
}

export interface MultiRunDeps {
  /** Joint: open every session as one recording and start Discover. */
  openJoint(sessions: PlannedSession[]): Promise<void>;
  /** Separate: open one session and start Discover. */
  openOne(session: PlannedSession, index: number): Promise<void>;
  stages(): {
    discover: StageActivity;
    extract: StageActivity;
    availability: Record<StageName, string | null>;
    runs: readonly StageRun[];
  };
  runExtract(): void;
  /** The export of the current result, all frames (null: no result). */
  exportInput(): ExportInput | null;
  /**
   * The trace QC of the extracted traces over frames `range` at `fps`
   * (`extract-qc.ts`), so each session's export carries its own QC rather
   * than the last snapshot of the run (omit: the export's `qc` as is).
   */
  sessionQc?(range: { start: number; end: number }, fps: number): Promise<QcSnapshot | null>;
  /** The open recording. */
  info(): FrameSourceInfo | null;
  /** Joint: Discover's session-boundary flags (`boundary-flags.ts`), written with each session's results. */
  boundaryFlags?(): readonly BoundaryFlag[];
  /** The run record (`run-provenance.ts`) of the run so far; folded into the run file. */
  runRecord?(settings: RunSettings, sessionIndex?: number): Record<string, unknown>;
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
  const [stopped, setStopped] = createSignal<string | null>(null);
  const [progressError, setProgressError] = createSignal<string | null>(null);
  /**
   * The current session's recording is open and its stages are its own. While a session opens,
   * the stage stores still hold the last session's finished stages; the automatic run waits, or it
   * would export (and write the next run's file) once more for a result it already wrote.
   */
  const [sessionOpen, setSessionOpen] = createSignal(false);
  /** The run being written: its folder, and what each of its sessions' exports hold. */
  let run:
    | (OpenedRun & {
        index: number;
        created: string;
        /** The planned run file is on disk (before the first frame). */
        planned: boolean;
        written: Map<number, NonNullable<RunFileSession['written']>>;
      })
    | null = null;
  /** The last record gathered for the run (reused by later writes of its file). */
  let lastRecord: Record<string, unknown> | null = null;
  /** The last action started, so an effect re-run does not start it twice. */
  let dispatched = '';

  const active = () => plan() !== null;
  const joint = () => plan()?.settings.mode === 'joint';

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

  /** Open the folder of run `index` (Joint: 0, the only one; Separate: session `index`). */
  async function openRun(index: number): Promise<void> {
    const p = plan()!;
    const opened = await p.openRun(index);
    run = { ...opened, index, created: now().toISOString(), planned: false, written: new Map() };
    lastRecord = null;
    setRoot(opened.sink.root);
  }

  /** The current run's file, as it is now. */
  function runDoc(status: RunFile['run']['status'], stoppedReason: string | null = null): RunFile {
    const p = plan()!;
    const r = run!;
    const mine = joint() ? records() : records().filter((x) => x.index === r.index);
    return calaRunFile({
      id: r.id,
      project: r.project,
      plan: p.planRef?.(r.index) ?? null,
      status,
      stopped: stoppedReason,
      created: r.created,
      updated: now().toISOString(),
      version: deps.version,
      joint: joint(),
      record: lastRecord,
      sessions: mine.map((rec) => ({
        record: rec,
        stream: p.sessions[rec.index].stream,
        info: p.sessions[rec.index].info,
        ...(r.written.has(rec.index) ? { written: r.written.get(rec.index)! } : {}),
      })),
    });
  }

  /** Write the current run's file and tell the project. */
  async function writeRun(
    status: RunFile['run']['status'],
    reason: string | null = null,
  ): Promise<RunFile> {
    const r = run!;
    const pl = plan();
    const doc = runDoc(status, reason);
    await r.sink.writeText(RUN_FILE, fileText('run', doc));
    if (pl?.onProgress) {
      try {
        await pl.onProgress({ run: doc, folder: r.folder, sink: r.sink });
      } catch (err) {
        setProgressError(errMsg(err));
      }
    }
    return doc;
  }

  /**
   * Before the run's first frame (the pipeline awaits this once its params are resolved): the
   * run file goes to disk with status `planned`, its config complete. A Restart of the same run
   * writes nothing new.
   */
  async function beforeFrames(): Promise<void> {
    const p = plan();
    if (!p || !run || run.planned || finished() || stopped()) return;
    lastRecord = deps.runRecord?.(p.settings, joint() ? undefined : run.index) ?? null;
    await writeRun('planned');
    run.planned = true;
  }

  /** Write the results that are final now: one session (Separate) or all (Joint). */
  async function exportResults(): Promise<void> {
    // The stage log ends Extract in an effect of its own on the same change
    // that starts this export: let it run first, or the stages would say
    // Extract is still running.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const p = plan();
    const base = deps.exportInput();
    if (!p || !base || !run) throw new Error('There is no Extract result to write.');
    const r = run;
    const isJoint = joint();
    const info = deps.info();
    // Joint: the spans of the recording as opened are the authority.
    if (isJoint && info?.sessions)
      for (const span of info.sessions)
        patchRecord(span.index, { startFrame: span.startFrame, frames: span.frameCount });
    if (isJoint)
      for (const f of deps.boundaryFlags?.() ?? []) patchRecord(f.index, { boundary: f });
    const which = isJoint ? records() : records().filter((x) => x.index === current());
    // Gathered here, at write time, once for the files written now.
    lastRecord = deps.runRecord?.(p.settings, isJoint ? undefined : r.index) ?? lastRecord;
    const created = now().toISOString();
    for (const rec of which) {
      const fps = rec.fps ?? base.fps;
      const range = isJoint
        ? { start: rec.startFrame, end: rec.startFrame + rec.frames }
        : { start: 0, end: base.result.frames };
      const qc = deps.sessionQc ? await deps.sessionQc(range, fps) : base.qc;
      // The copy in the export shows its own result as written.
      r.written.set(rec.index, {
        cells: base.result.ids.length,
        libraryVersion: base.result.version,
        created,
      });
      patchRecord(rec.index, { status: 'written' });
      const input: ExportInput = {
        ...base,
        label: rec.name,
        fps,
        qc,
        ...(isJoint
          ? { frameRange: { start: rec.startFrame, end: rec.startFrame + rec.frames } }
          : {}),
        session: exportSessionBlock(rec, p.settings.mode, p.sessions.length),
        runFile: runDoc('running'),
      };
      const path =
        rec.resultsPath === '.' || rec.resultsPath === ''
          ? CALA_EXPORT_FILE
          : `${rec.resultsPath}/${CALA_EXPORT_FILE}`;
      await r.sink.writeFile(path, (s) => writeCalaExport(input, s));
    }
    await writeRun('running');
  }

  /** The current run is over: its file says so and its folder is closed (a zip is offered). */
  async function closeRun(
    status: 'finished' | 'stopped',
    reason: string | null = null,
  ): Promise<void> {
    if (!run) return;
    await writeRun(status, reason);
    await run.sink.finish();
  }

  async function finish(skipped?: string): Promise<void> {
    if (skipped) patchRecord(current(), { status: 'skipped', note: skipped });
    await closeRun('finished');
    setFinished(true);
  }

  /** A stage failed or was cancelled: the run stops; what is written stays. */
  async function stop(reason: string): Promise<void> {
    const p = plan();
    if (!p) return;
    setStopped(reason);
    const open = records().filter(
      (r) => r.status === 'pending' && (joint() || r.index === current()),
    );
    for (const r of open) patchRecord(r.index, { status: 'failed', note: reason });
    if (run) await writeRun('stopped', reason);
  }

  /** Separate: the session's run is done; the next session is a run of its own. */
  async function nextSession(skipped?: string): Promise<void> {
    const p = plan()!;
    if (skipped) patchRecord(current(), { status: 'skipped', note: skipped });
    await closeRun('finished');
    const next = current() + 1;
    // The next run's folder is open before the session changes, so nothing is written to the last.
    await openRun(next);
    batch(() => {
      setSessionOpen(false);
      setCurrent(next);
      setExported(false);
    });
    await deps.openOne(p.sessions[next], next);
    setSessionOpen(true);
  }

  /** Run `job` once for `key`; failures stop the automatic run with a message. */
  function dispatch(key: string, job: () => Promise<void> | void): void {
    if (dispatched === key) return;
    dispatched = key;
    void (async () => {
      try {
        await job();
      } catch (err) {
        setError(errMsg(err));
        if (run) await writeRun('stopped', errMsg(err)).catch(() => {});
      }
    })();
  }

  // The automatic run: one step whenever a stage's state changes.
  createEffect(() => {
    const p = plan();
    if (!p || !sessionOpen() || finished() || error() || stopped()) return;
    const st = deps.stages();
    // The Extract store keeps the last session's `done` until it runs again; the stage log
    // starts over with each Discover. A `done` the log does not hold is not this session's.
    // (An Extract refused before it starts goes to `error` without a log entry: that one stays.)
    const extract =
      st.extract === 'done' && !st.runs.some((r) => r.stage === 'extract') ? 'idle' : st.extract;
    const input = {
      settings: p.settings,
      discover: st.discover,
      extract,
      availability: st.availability,
      exported: exported(),
      exporting: exporting(),
      session: current(),
      sessions: p.sessions.length,
    };
    const a = nextAutoAction(input);
    setAction(a);
    const key = `${current()}:${a.kind}:${st.runs.length}`;
    untrack(() => {
      switch (a.kind) {
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
        case 'stopped':
          dispatch(key, () => stop(a.reason));
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
    run = null;
    dispatched = '';
    setRoot(null);
    setError(null);
    setStopped(null);
    setProgressError(null);
    setFinished(false);
    setSessionOpen(false);
    setExported(false);
    setCurrent(0);
    setPlan(p);
    setRecords(recordsFor(p));
    try {
      await openRun(0);
    } catch (err) {
      setError(errMsg(err));
      return;
    }
    if (p.settings.mode === 'joint') await deps.openJoint(p.sessions);
    else await deps.openOne(p.sessions[0], 0);
    setSessionOpen(true);
  }

  /** Leave the run (Back to project, a new folder): an unfinished run's file says it stopped. */
  function cancel(): void {
    if (run && plan() && !finished() && !stopped() && !error())
      void writeRun('stopped', 'The run was left before it finished.').catch(() => {});
    setPlan(null);
    run = null;
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
      if (stopped()) return `Stopped: ${stopped()}`;
      if (finished()) return 'All sessions done; results written.';
      return autoStatusText(action(), {
        session: current(),
        sessions: p.sessions.length,
        joint: p.settings.mode === 'joint',
      });
    },
    error,
    /** Why the automatic run stopped (a stage failed or was cancelled), or a write failed. */
    stopped: () => stopped() ?? error(),
    /** Updating the project index failed (the run went on). */
    progressError,
    exporting,
    finished,
    /** The run folder, once the run has started. */
    root,
    /** The current run's file as it is now (null: no run). */
    runFile: (): RunFile | null =>
      run && plan() ? runDoc(run.planned ? 'running' : 'planned') : null,
    beforeFrames,
    start,
    stop: cancel,
  };
}

export type MultiRun = ReturnType<typeof createMultiRun>;
