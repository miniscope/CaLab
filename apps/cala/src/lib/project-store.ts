/**
 * The open project (an animal folder; `docs/projects.md`): its sessions, as scanned and probed,
 * its project file (intent: the plan, hand-set current results), the index (a cache rebuilt
 * from the run files) and the actions of the project view. Runs go through the multi-session
 * runner (`multi-run.ts`), one plan step at a time; `ProjectWriter` keeps the files in line as
 * each run file is written.
 */
import { createEffect, createSignal, on, untrack } from 'solid-js';
import {
  addSteps,
  afterStep,
  emptyProject,
  fileText,
  findRunFiles,
  INDEX_FILE,
  moveStep,
  OLD_RESULTS_DIR,
  oldFormatMessage,
  PROJECT_DIR,
  PROJECT_FILE,
  projectStreamRefs,
  readProjectFile,
  rebuildIndex,
  reconcileStreams,
  removeStep,
  runIdFor,
  runnableSteps,
  stepFinished,
  stepStarted,
  stepStopped,
  streamRef,
  timeId,
  withRun,
  type IndexFile,
  type IndexStream,
  type PlanState,
  type PlanStep,
  type ProjectFile,
  type ProjectTextFile,
  type ScannedStream,
} from '@calab/project';
import type { FolderEntry, SessionInput } from './frame-source.ts';
import type { SessionProbeResult } from '../workers/frame-types.ts';
import type { MultiRun, OpenedRun, PlannedSession, RunProgress } from './multi-run.ts';
import {
  projectSessionId,
  sessionStatus,
  sharedIdGroups,
  type ProjectResult,
} from './project-index.ts';
import {
  existingDir,
  fileAt,
  fileInEntries,
  projectFilesFromEntries,
  projectRunSink,
  projectZipSink,
  readProjectFiles,
  writeProject,
  type ReadDirLike,
} from './project-io.ts';
import { readStartMs, toSessionInput } from './session-list.ts';
import type { WritableDirLike } from './session-export.ts';
import { ensurePermission } from './fs-handles.ts';
import { uniqueResultsPaths, validateSessions, type SessionCandidate } from './sessions.ts';
import { rememberProject, type RecentStore } from './recent-projects.ts';
import { CALA_APP } from './run-file.ts';
import { errMsg } from './errors.ts';

export interface ProjectOpen {
  rootName: string;
  entries: FolderEntry[];
  /** The animal folder (File System Access API); null when picked through a file input. */
  handle: ReadDirLike | null;
  sessions: SessionCandidate[];
  /** A results folder chosen earlier (recent projects): it holds the project files. */
  resultsHandle?: ReadDirLike | null;
}

/** One table row's session: what the scan and the probe found. */
export interface ProjectSessionRow {
  candidate: SessionCandidate;
  planned: PlannedSession;
}

export interface ProjectDeps {
  probe(sessions: SessionInput[]): Promise<SessionProbeResult[]>;
  multiRun: MultiRun;
  recent?: RecentStore;
  version: string;
  now?: () => Date;
}

/**
 * The project file and the index of one project folder, kept in line as runs write their run
 * files: the index takes each run file, and the plan follows each run's status (a step starts
 * with its run, leaves the plan when the run finishes, and stays, stopped, when it stops). With
 * a folder the files are written in place; without one (a zip download) they go into the run's
 * zip. The project file is never written when it is read-only (it could not be read, or a newer
 * cala wrote it).
 */
export class ProjectWriter {
  constructor(
    public project: ProjectFile,
    public index: IndexFile,
    private readonly o: {
      /** The project folder, created if needed (null: no File System Access API). */
      dir: (() => Promise<WritableDirLike>) | null;
      /** For people: where the project folder is. */
      label: string;
      now: () => Date;
      readOnly?: boolean;
      onChange?: () => void;
    },
  ) {}

  /** Write both files (the project file only when it is ours to change). */
  async save(): Promise<void> {
    this.o.onChange?.();
    if (!this.o.dir) return;
    await writeProject(await this.o.dir(), this.o.readOnly ? null : this.project, this.index);
  }

  /** The folder of a new run, named `id` (a suffix is added when taken). */
  async openRun(id: string): Promise<OpenedRun> {
    const opened = this.o.dir
      ? await projectRunSink(await this.o.dir(), id, this.o.label)
      : projectZipSink(id);
    return { ...opened, project: this.project.project.id };
  }

  /** A run file was written: index it, move the plan along, and write the files. */
  async record(p: RunProgress): Promise<void> {
    const now = this.o.now();
    this.index = withRun(this.index, p.run, p.folder, now);
    const ref = p.run.run.plan;
    const step = ref && this.project.plan.steps.find((s) => s.id === ref.step);
    if (step) {
      const st = p.run.run.status;
      let plan = this.project.plan;
      if ((st === 'planned' || st === 'running') && !step.runs.includes(p.run.run.id))
        plan = stepStarted(plan, step.id, p.run.run.id);
      else if (st === 'finished') plan = stepFinished(plan, step.id);
      else if (st === 'stopped') plan = stepStopped(plan, step.id);
      if (plan !== this.project.plan)
        this.project = {
          ...this.project,
          plan,
          project: { ...this.project.project, updated: now.toISOString() },
        };
    }
    if (p.sink.writeProjectText) {
      this.o.onChange?.();
      if (!this.o.readOnly)
        await p.sink.writeProjectText(PROJECT_FILE, fileText('project', this.project));
      await p.sink.writeProjectText(INDEX_FILE, fileText('index', this.index));
    } else await this.save();
  }
}

/** The project's streams as the index lists them: the scan's facts, missing ones flagged. */
function indexStreams(project: ProjectFile, rows: readonly ProjectSessionRow[]): IndexStream[] {
  const byRef = new Map(rows.map((r) => [r.planned.stream, r.planned]));
  return project.sessions.flatMap((s) =>
    s.streams.map((x) => {
      const ref = streamRef(s.id, x.id);
      const p = byRef.get(ref);
      return {
        ref,
        role: x.role,
        start: s.start,
        frames: p?.info?.frameCount ?? x.frames,
        fps: p?.info?.fps ?? null,
        width: p?.info?.width ?? null,
        height: p?.info?.height ?? null,
        bit_depth: p?.info?.bitDepth ?? null,
        missing: !p,
        previous_refs: x.previous_ids,
      };
    }),
  );
}

async function hasReadwrite(handle: unknown): Promise<boolean> {
  const h = handle as { queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState> };
  if (typeof h?.queryPermission !== 'function') return false;
  try {
    return (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/** The plan's run of `step` as the multi-session runner takes it. */
function modeOf(step: PlanStep): 'joint' | 'separate' {
  return step.kind === 'joint' ? 'joint' : 'separate';
}

export function createProjectStore(deps: ProjectDeps) {
  const now = deps.now ?? (() => new Date());
  const [opened, setOpened] = createSignal<ProjectOpen | null>(null);
  const [rows, setRows] = createSignal<ProjectSessionRow[]>([]);
  const [project, setProject] = createSignal<ProjectFile | null>(null);
  const [index, setIndex] = createSignal<IndexFile | null>(null);
  const [warnings, setWarnings] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  /** The project file could not be read (or is newer): it is shown, never written. */
  const [readOnly, setReadOnly] = createSignal(false);
  /** The files in memory differ from the folder (saved at the next write). */
  const [dirty, setDirty] = createSignal(false);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [planState, setPlanState] = createSignal<PlanState>({ kind: 'idle' });
  /** The steps of the plan that is running (or ran last). */
  const [running, setRunning] = createSignal<PlanStep[] | null>(null);
  const [resultsHandle, setResultsHandle] = createSignal<ReadDirLike | null>(null);
  let writer: ProjectWriter | null = null;

  const location = () => {
    const custom = resultsHandle();
    const root = opened()?.rootName ?? '';
    return custom
      ? { kind: 'custom' as const, label: custom.name }
      : { kind: 'default' as const, label: `${root}/${PROJECT_DIR}` };
  };
  /** Results can be written to a folder (File System Access API). */
  const canWrite = () =>
    opened()?.handle != null && typeof opened()?.handle?.getDirectoryHandle === 'function';

  /** The project folder to read: the custom one, or `<animal>/calab-project` if it exists. */
  async function projectDirForRead(): Promise<ReadDirLike | null> {
    const custom = resultsHandle();
    if (custom) return custom;
    const h = opened()?.handle;
    return h ? existingDir(h, PROJECT_DIR) : null;
  }

  /** The project folder to write, created if needed; `readwrite` must already be granted. */
  async function projectDirForWrite(): Promise<WritableDirLike> {
    const custom = resultsHandle();
    if (custom) return custom as unknown as WritableDirLike;
    const h = opened()?.handle as unknown as WritableDirLike | null;
    if (!h) throw new Error('This browser cannot write to the folder.');
    return h.getDirectoryHandle(PROJECT_DIR, { create: true });
  }

  /** Ask for `readwrite` where results go (inside a click). */
  async function grant(): Promise<boolean> {
    if (!canWrite()) return true;
    const target = resultsHandle() ?? opened()?.handle;
    return target ? ensurePermission(target, 'readwrite') : false;
  }

  async function readFiles(): Promise<ProjectTextFile[]> {
    const o = opened();
    if (!o) return [];
    if (o.handle) {
      const dir = await projectDirForRead();
      return dir ? readProjectFiles(dir) : [];
    }
    return projectFilesFromEntries(o.entries, o.rootName);
  }

  /** Whether the animal folder holds a results tree of an older cala. */
  async function hasOldTree(): Promise<boolean> {
    const o = opened()!;
    if (o.handle) return (await existingDir(o.handle, OLD_RESULTS_DIR)) !== null;
    return o.entries.some((e) => e.relPath.startsWith(`${o.rootName}/${OLD_RESULTS_DIR}/`));
  }

  /** The export file of a result (for View results). */
  async function resultFile(r: Pick<ProjectResult, 'export_path'>): Promise<File> {
    const o = opened();
    if (!o) throw new Error('No project is open.');
    if (o.handle) {
      const dir = await projectDirForRead();
      if (!dir) throw new Error('The project folder is gone.');
      return fileAt(dir, r.export_path);
    }
    return fileInEntries(o.entries, o.rootName, r.export_path);
  }

  function scanned(): ScannedStream[] {
    return rows().map(({ planned: p }) => ({
      ref: p.stream,
      role: 'miniscope',
      startMs: p.startMs,
      frames: p.info?.frameCount ?? null,
    }));
  }

  function makeWriter(p: ProjectFile, idx: IndexFile): ProjectWriter {
    return new ProjectWriter(p, idx, {
      dir: canWrite() ? projectDirForWrite : null,
      label: location().label,
      now,
      readOnly: readOnly(),
      onChange: () => {
        setProject(writer!.project);
        setIndex(writer!.index);
      },
    });
  }

  /** Read the project file and the run files; rebuild the index; bring both in line with the scan. */
  async function load(): Promise<void> {
    const o = opened()!;
    const files = await readFiles();
    const notes: string[] = [];
    const t = now();
    let changed = false;
    setReadOnly(false);
    if (await hasOldTree()) notes.push(oldFormatMessage(`${o.rootName}/${OLD_RESULTS_DIR}/`));
    const pf = files.find((f) => f.path === PROJECT_FILE);
    let p: ProjectFile;
    if (!pf) {
      p = emptyProject(o.rootName, t);
      changed = true;
    } else {
      const r = readProjectFile(pf.text);
      if (r.ok) {
        p = r.value;
        if (r.migratedFrom !== null) changed = true;
      } else {
        // Intent is never replaced by a fresh file: the project opens read-only.
        p = emptyProject(o.rootName, t);
        setReadOnly(true);
        notes.push(
          `${PROJECT_FILE} could not be read (${r.error}). The project is shown from its run files and nothing will be written; fix or move the file to run here.`,
        );
      }
    }
    const rec = reconcileStreams(p, scanned());
    if (JSON.stringify(rec.project.sessions) !== JSON.stringify(p.sessions)) changed = true;
    p = rec.project;
    for (const [a, b] of rec.renamed)
      notes.push(`${a} was renamed to ${b}; its results follow it.`);
    if (rec.missing.length > 0)
      notes.push(
        `Missing session folder${rec.missing.length === 1 ? '' : 's'}: ${rec.missing.join(', ')}.`,
      );
    const found = findRunFiles(files);
    for (const f of found.refused) notes.push(`${f.path}: ${f.error}`);
    const idx = rebuildIndex(found.runs, indexStreams(p, rows()), t);
    if (changed) p = { ...p, project: { ...p.project, updated: t.toISOString() } };
    writer = makeWriter(p, idx);
    setProject(p);
    setIndex(idx);
    setWarnings(notes);
    setDirty(changed);
    // Saved at once when writing is already allowed (a reopened project), else at the next change.
    if (canWrite() && (await hasReadwrite(resultsHandle() ?? o.handle))) await persist();
  }

  /** Write the files now if this browser may, else keep them for the next write. */
  async function persist(): Promise<void> {
    if (!writer) return;
    if (canWrite() && (await hasReadwrite(resultsHandle() ?? opened()?.handle))) {
      await writer.save();
      setDirty(false);
    } else {
      setProject(writer.project);
      setDirty(true);
    }
  }

  async function open(o: ProjectOpen): Promise<void> {
    setLoading(true);
    setError(null);
    setOpened(o);
    setResultsHandle(o.resultsHandle ?? null);
    setSelected(new Set<string>());
    setPlanState({ kind: 'idle' });
    setProject(null);
    setIndex(null);
    writer = null;
    try {
      const [starts, probed] = await Promise.all([
        Promise.all(o.sessions.map(readStartMs)),
        deps
          .probe(o.sessions.map(toSessionInput))
          .catch((err: unknown) => o.sessions.map(() => ({ error: errMsg(err) }))),
      ]);
      const paths = uniqueResultsPaths(o.sessions.map((c) => c.dir));
      setRows(
        o.sessions.map((candidate, i) => {
          const r = probed[i];
          return {
            candidate,
            planned: {
              candidate,
              info: r && 'info' in r ? r.info : null,
              error: r && 'error' in r ? r.error : null,
              startMs: starts[i],
              resultsPath: paths[i],
              stream: projectSessionId(candidate.dir),
            },
          };
        }),
      );
      await load();
      if (o.handle && deps.recent)
        await rememberProject(deps.recent, o.handle, o.resultsHandle ?? null, now());
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }

  /** Read the files again (after a run; the scan stays). */
  async function refresh(): Promise<void> {
    if (!opened()) return;
    try {
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  /** The project folder is one the user picked (`readwrite` granted by the picker). */
  async function useResultsFolder(handle: ReadDirLike): Promise<void> {
    setResultsHandle(handle);
    const o = opened();
    if (o?.handle && deps.recent) await rememberProject(deps.recent, o.handle, handle, now());
    await refresh();
  }

  function close(): void {
    setOpened(null);
    setRows([]);
    setProject(null);
    setIndex(null);
    setWarnings([]);
    setSelected(new Set<string>());
    setResultsHandle(null);
    setPlanState({ kind: 'idle' });
    writer = null;
  }

  // ---- Table ----

  /** Table rows: the project's streams (missing ones included) in its order. */
  const tableRows = () => {
    const p = project();
    const idx = index();
    if (!p || !idx) return [];
    const byId = new Map(rows().map((r) => [r.planned.stream, r]));
    const facts = new Map(idx.streams.map((s) => [s.ref, s]));
    return projectStreamRefs(p).map((ref) => {
      const f = facts.get(ref);
      return {
        session: {
          id: ref,
          start: f?.start ?? null,
          frames: f?.frames ?? null,
          fps: f?.fps ?? null,
          missing: !byId.has(ref),
        },
        row: byId.get(ref) ?? null,
        status: sessionStatus(idx, p.current, ref),
      };
    });
  };

  const idGroups = () => {
    const p = project();
    const idx = index();
    return p && idx ? sharedIdGroups(idx, p.current) : new Map();
  };

  function toggle(id: string, on?: boolean): void {
    const next = new Set(selected());
    if (on ?? !next.has(id)) next.add(id);
    else next.delete(id);
    setSelected(next);
  }
  function selectAll(on: boolean): void {
    setSelected(
      on
        ? new Set(
            tableRows()
              .filter((r) => r.row)
              .map((r) => r.session.id),
          )
        : new Set<string>(),
    );
  }

  /** Change the project file (plan, current) and write it when allowed. */
  async function edit(change: (p: ProjectFile) => ProjectFile): Promise<void> {
    if (!writer) return;
    writer.project = change(writer.project);
    writer.project = {
      ...writer.project,
      project: { ...writer.project.project, updated: now().toISOString() },
    };
    setProject(writer.project);
    try {
      await persist();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function setCurrent(session: string, run: string): Promise<void> {
    if (!writer) return;
    setError(null);
    if (canWrite() && !readOnly() && !(await grant())) {
      setError('The browser did not allow writing to the project folder.');
      return;
    }
    await edit((p) => ({
      ...p,
      current: { ...p.current, [CALA_APP]: { ...(p.current[CALA_APP] ?? {}), [session]: run } },
    }));
  }

  // ---- Plan ----

  const plan = () => project()?.plan.steps ?? [];
  const order = () => tableRows().map((r) => r.session.id);
  function addToPlan(kind: 'joint' | 'separate'): void {
    const ids = [...selected()].filter((id) =>
      tableRows().some((r) => r.session.id === id && r.row),
    );
    if (ids.length === 0) return;
    void edit((p) => ({ ...p, plan: addSteps(p.plan, CALA_APP, kind, ids, order()) }));
    setSelected(new Set<string>());
  }

  /**
   * A Joint chain's boundary failed: put its sessions (those still in the
   * table) into the plan as Separate runs. Only edits the plan; nothing runs.
   */
  function replanSeparate(ids: readonly string[]): void {
    const keep = ids.filter((id) => tableRows().some((r) => r.session.id === id && r.row));
    if (keep.length === 0) return;
    void edit((p) => ({ ...p, plan: addSteps(p.plan, CALA_APP, 'separate', keep, order()) }));
  }

  /** Problems that keep the plan from starting, per step. */
  function planErrors(): string[] {
    const out: string[] = [];
    if (readOnly()) out.push(`${PROJECT_FILE} could not be read; nothing can be run here.`);
    const byId = new Map(rows().map((r) => [r.planned.stream, r]));
    plan().forEach((g, gi) => {
      const list = g.streams.map((id) => byId.get(id));
      for (const [i, r] of list.entries()) {
        if (!r) out.push(`Step ${gi + 1}: ${g.streams[i]} is missing.`);
        else if (r.planned.error) out.push(`Step ${gi + 1}: ${g.streams[i]}: ${r.planned.error}`);
      }
      if (g.kind === 'joint') {
        const ok = list.filter((r) => r?.planned.info);
        const v = validateSessions(
          ok.map((r) => ({
            name: r!.planned.stream,
            width: r!.planned.info!.width,
            height: r!.planned.info!.height,
            bitDepth: r!.planned.info!.bitDepth,
            fps: r!.planned.info!.fps,
          })),
        );
        for (const e of v.errors) out.push(`Step ${gi + 1}: ${e}`);
      }
    });
    return out;
  }

  function plannedFor(ids: readonly string[]): PlannedSession[] {
    const byId = new Map(rows().map((r) => [r.planned.stream, r.planned]));
    const list = ids.map((id) => byId.get(id)!).filter(Boolean);
    const paths = uniqueResultsPaths(list.map((p) => p.candidate.dir));
    return list.map((p, i) => ({ ...p, resultsPath: paths[i] }));
  }

  async function startStep(steps: PlanStep[], k: number): Promise<void> {
    const step = steps[k];
    const w = writer!;
    const planId = w.project.plan.id!;
    setPlanState({ kind: 'running', step: k });
    await deps.multiRun.start({
      sessions: plannedFor(step.streams),
      settings: { mode: modeOf(step) },
      // The sink's root is the full path (`<animal>/calab-project/runs/<id>`).
      locationLabel: canWrite() ? '' : 'a zip download: ',
      planRef: () => ({ id: planId, step: step.id, kind: step.kind }),
      openRun: () => w.openRun(runIdFor(now(), CALA_APP, new Set(w.index.runs.map((r) => r.id)))),
      onProgress: (p) => w.record(p),
    });
  }

  /**
   * Start the plan (inside the Start click: `readwrite` is asked for first). The plan is written
   * to the project file before its first step runs. Resolves false when writing was refused.
   */
  async function startPlan(): Promise<boolean> {
    const steps = runnableSteps(project()?.plan ?? { id: null, steps: [] });
    if (!writer || steps.length === 0 || planErrors().length > 0) return false;
    if (!(await grant())) return false;
    const t = now();
    writer.project = {
      ...writer.project,
      plan: { ...writer.project.plan, id: timeId(t) },
      project: { ...writer.project.project, updated: t.toISOString() },
    };
    await writer.save();
    setDirty(false);
    setRunning(steps);
    await startStep(steps, 0);
    return true;
  }

  // Steps run one after another: the next starts when the multi-session run finishes.
  createEffect(
    on(
      () => [deps.multiRun.finished(), deps.multiRun.stopped()] as const,
      ([finished, stopped]) => {
        const st = untrack(planState);
        const steps = untrack(running);
        if (st.kind !== 'running' || !steps) return;
        if (!finished && !stopped) return;
        const next = afterStep(steps.length, st.step, stopped ? { stopped } : { finished: true });
        setPlanState(next);
        if (next.kind === 'running') void startStep(steps, next.step);
      },
    ),
  );

  return {
    opened,
    rows,
    /** The project file as it is now (null: none open). */
    project,
    index,
    tableRows,
    idGroups,
    warnings,
    loading,
    error,
    readOnly,
    dirty,
    canWrite,
    location,
    selected,
    toggle,
    selectAll,
    /** The plan's steps. */
    plan,
    addToPlan,
    replanSeparate,
    removeGroup: (i: number) => {
      const id = plan()[i]?.id;
      if (id) void edit((p) => ({ ...p, plan: removeStep(p.plan, id) }));
    },
    moveGroup: (from: number, to: number) => {
      const id = plan()[from]?.id;
      if (id) void edit((p) => ({ ...p, plan: moveStep(p.plan, id, to) }));
    },
    clearPlan: () =>
      void edit((p) => ({
        ...p,
        plan: { ...p.plan, steps: p.plan.steps.filter((s) => s.status === 'running') },
      })),
    planErrors,
    planState,
    running,
    startPlan,
    setCurrent,
    open,
    refresh,
    useResultsFolder,
    close,
    grant,
    resultFile,
  };
}

export type ProjectStore = ReturnType<typeof createProjectStore>;

/**
 * The project folder of a multi-session run started from the session setup (outside the
 * project view): `<location>/calab-project/`, made or added to, with one plan step per run
 * (Joint: one; Separate: one per session) written before the first run starts. Throws when the
 * folder's project file cannot be read: it is never replaced.
 */
export async function sessionSetupProject(o: {
  /** Where the project folder goes (null: no File System Access API; the files go into a zip). */
  location: WritableDirLike | null;
  name: string;
  sessions: readonly PlannedSession[];
  mode: 'joint' | 'separate';
  now: () => Date;
}): Promise<{ writer: ProjectWriter; steps: PlanStep[] }> {
  const t = o.now();
  const dir = o.location
    ? await o.location.getDirectoryHandle(PROJECT_DIR, { create: true })
    : null;
  const files = dir ? await readProjectFiles(dir as unknown as ReadDirLike) : [];
  let project = emptyProject(o.name, t);
  const pf = files.find((f) => f.path === PROJECT_FILE);
  if (pf) {
    const r = readProjectFile(pf.text);
    if (!r.ok)
      throw new Error(
        `${PROJECT_DIR}/${PROJECT_FILE} could not be read (${r.error}); nothing was written.`,
      );
    project = r.value;
  }
  const refs = o.sessions.map((s) => s.stream);
  project = reconcileStreams(
    project,
    o.sessions.map((s) => ({
      ref: s.stream,
      role: 'miniscope',
      startMs: s.startMs,
      frames: s.info?.frameCount ?? null,
    })),
  ).project;
  const before = new Set(project.plan.steps.map((s) => s.id));
  const plan = addSteps(project.plan, CALA_APP, o.mode, refs, refs);
  project = {
    ...project,
    plan: { ...plan, id: timeId(t) },
    project: { ...project.project, updated: t.toISOString() },
  };
  const steps = project.plan.steps.filter((s) => !before.has(s.id));
  const rows = o.sessions.map((planned) => ({ candidate: planned.candidate, planned }));
  const index = rebuildIndex(findRunFiles(files).runs, indexStreams(project, rows), t);
  const writer = new ProjectWriter(project, index, {
    dir: dir ? async () => dir : null,
    label: `${o.location?.name ?? ''}/${PROJECT_DIR}`,
    now: o.now,
  });
  await writer.save();
  return { writer, steps };
}
