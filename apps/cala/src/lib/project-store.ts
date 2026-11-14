/**
 * The open project (an animal folder; `docs/projects.md`): its sessions, as
 * scanned and probed, its index, the run plan, and the actions of the
 * project view. Runs go through the multi-session runner (`multi-run.ts`);
 * this store builds each group's plan and keeps the index up to date as
 * results are written.
 */
import { boundaryFlagJson } from './boundary-flags.ts';
import { createEffect, createSignal, on, untrack } from 'solid-js';
import type { FolderEntry, SessionInput } from './frame-source.ts';
import type { SessionProbeResult } from '../workers/frame-types.ts';
import type { MultiRun, PlannedSession, RunProgress } from './multi-run.ts';
import {
  addResult,
  emptyIndex,
  findRuns,
  mergeRuns,
  parseIndex,
  projectSessionId,
  PROJECT_INDEX_FILE,
  rebuildIndex,
  reconcileSessions,
  runIdFor,
  sessionStatus,
  setCurrent as setCurrentIn,
  upsertRun,
  EXPORT_FILE,
  idSpaceFor,
  RUNS_DIR,
  type ProjectIndex,
  type ProjectResult,
  type ProjectRun,
  type ProjectRunSession,
  type ResultsFile,
  type ResultsLocation,
  type ScannedSession,
  type StageRecord,
} from './project-index.ts';
import {
  existingDir,
  fileAt,
  fileInEntries,
  projectRunSink,
  projectZipSink,
  readResultsFiles,
  resultsFilesFromEntries,
  writeIndex,
  type ReadDirLike,
} from './project-io.ts';
import {
  addGroup,
  afterGroup,
  moveGroup,
  removeGroup,
  type GroupKind,
  type PlanGroup,
  type PlanState,
} from './run-plan.ts';
import { readStartMs, toSessionInput } from './session-list.ts';
import { ensureReadwrite, type WritableDirLike } from './session-export.ts';
import {
  RESULTS_DIR,
  uniqueResultsPaths,
  validateSessions,
  type SessionCandidate,
} from './sessions.ts';
import { stageMeta } from './export.ts';
import { rememberProject, type RecentStore } from './recent-projects.ts';

export interface ProjectOpen {
  rootName: string;
  entries: FolderEntry[];
  /** The animal folder (File System Access API); null when picked through a file input. */
  handle: ReadDirLike | null;
  sessions: SessionCandidate[];
  /** A results folder chosen earlier (recent projects). */
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

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, '-');

async function hasReadwrite(handle: unknown): Promise<boolean> {
  const h = handle as { queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState> };
  if (typeof h?.queryPermission !== 'function') return false;
  try {
    return (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

export function createProjectStore(deps: ProjectDeps) {
  const now = deps.now ?? (() => new Date());
  const [opened, setOpened] = createSignal<ProjectOpen | null>(null);
  const [rows, setRows] = createSignal<ProjectSessionRow[]>([]);
  const [index, setIndex] = createSignal<ProjectIndex | null>(null);
  const [warnings, setWarnings] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [readOnly, setReadOnly] = createSignal(false);
  /** The index in memory differs from the file (saved at the next write). */
  const [dirty, setDirty] = createSignal(false);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [plan, setPlan] = createSignal<PlanGroup[]>([]);
  const [planState, setPlanState] = createSignal<PlanState>({ kind: 'idle' });
  const [running, setRunning] = createSignal<PlanGroup[] | null>(null);
  const [resultsHandle, setResultsHandle] = createSignal<ReadDirLike | null>(null);
  let corrupt: { text: string; stamp: string } | null = null;
  let planId = '';
  let refineRuns = 1;

  const location = (): ResultsLocation => {
    const custom = resultsHandle();
    const root = opened()?.rootName ?? '';
    return custom
      ? { kind: 'custom', label: custom.name }
      : { kind: 'default', label: `${root}/${RESULTS_DIR}` };
  };
  /** Results can be written to a folder (File System Access API). */
  const canWrite = () =>
    opened()?.handle != null && typeof opened()?.handle?.getDirectoryHandle === 'function';

  /** The results folder to read: the custom one, or `<animal>/cala-results` if it exists. */
  async function resultsDirForRead(): Promise<ReadDirLike | null> {
    const custom = resultsHandle();
    if (custom) return custom;
    const h = opened()?.handle;
    return h ? existingDir(h, RESULTS_DIR) : null;
  }

  /** The results folder to write, created if needed; `readwrite` must already be granted. */
  async function resultsDirForWrite(): Promise<WritableDirLike> {
    const custom = resultsHandle();
    if (custom) return custom as unknown as WritableDirLike;
    const h = opened()?.handle as unknown as WritableDirLike | null;
    if (!h) throw new Error('This browser cannot write to the folder.');
    return h.getDirectoryHandle(RESULTS_DIR, { create: true });
  }

  /** Ask for `readwrite` where results go (inside a click). */
  async function grant(): Promise<boolean> {
    if (!canWrite()) return true;
    const target = resultsHandle() ?? opened()?.handle;
    return target ? ensureReadwrite(target) : false;
  }

  async function readFiles(): Promise<ResultsFile[]> {
    const o = opened();
    if (!o) return [];
    if (o.handle) {
      const dir = await resultsDirForRead();
      return dir ? readResultsFiles(dir) : [];
    }
    return resultsFilesFromEntries(o.entries, o.rootName);
  }

  /** The export file of a result (for View results). */
  async function resultFile(r: Pick<ProjectResult, 'export_path'>): Promise<File> {
    const o = opened();
    if (!o) throw new Error('No project is open.');
    if (o.handle) {
      const dir = await resultsDirForRead();
      if (!dir) throw new Error('The results folder is gone.');
      return fileAt(dir, r.export_path);
    }
    return fileInEntries(o.entries, o.rootName, r.export_path);
  }

  function scanned(): ScannedSession[] {
    return rows().map(({ planned: p }) => ({
      id: projectSessionId(p.candidate.dir),
      startMs: p.startMs,
      frames: p.info?.frameCount ?? null,
      fps: p.info?.fps ?? null,
      width: p.info?.width ?? null,
      height: p.info?.height ?? null,
      bitDepth: p.info?.bitDepth ?? null,
    }));
  }

  /** Read the index (or rebuild it) and bring it in line with the scan and the run folders. */
  async function loadIndex(): Promise<void> {
    const o = opened()!;
    const files = await readFiles();
    const notes: string[] = [];
    const t = now();
    const idxFile = files.find((f) => f.path === PROJECT_INDEX_FILE);
    let idx: ProjectIndex;
    let changed = false;
    corrupt = null;
    setReadOnly(false);
    const rebuild = () => {
      const r = rebuildIndex(o.rootName, location(), scanned(), files, t);
      for (const u of r.unreadable) notes.push(`${u} could not be read; it was left out.`);
      return r.index;
    };
    if (!idxFile) {
      idx = rebuild();
      changed = true;
      if (idx.runs.length > 0)
        notes.push(
          `The project index was built from ${idx.runs.length} existing run folder${idx.runs.length === 1 ? '' : 's'}.`,
        );
    } else {
      const r = parseIndex(idxFile.text);
      if (r.ok) {
        const rec = reconcileSessions(r.index, scanned());
        const { runs, unreadable } = findRuns(files);
        const merged = mergeRuns(rec.index, runs);
        idx = merged.index;
        for (const u of unreadable) notes.push(`${u} could not be read; it was left out.`);
        for (const [a, b] of rec.renamed)
          notes.push(`${a} was renamed to ${b}; its results follow it.`);
        if (rec.missing.length > 0)
          notes.push(
            `Missing session folder${rec.missing.length === 1 ? '' : 's'}: ${rec.missing.join(', ')}.`,
          );
        if (merged.added.length > 0)
          notes.push(`Run folders added to the index: ${merged.added.join(', ')}.`);
        if (r.index.project.root_name !== o.rootName)
          notes.push(
            `This index was made for "${r.index.project.root_name}", not "${o.rootName}".`,
          );
        changed = JSON.stringify(idx) !== JSON.stringify(r.index);
        if (changed) idx = { ...idx, project: { ...idx.project, updated: t.toISOString() } };
      } else if (r.newer) {
        idx = rebuild();
        setReadOnly(true);
        notes.push(
          `${PROJECT_INDEX_FILE} was written by a newer cala (${r.error}). It is shown rebuilt from the run folders and will not be changed.`,
        );
      } else {
        idx = rebuild();
        changed = true;
        corrupt = { text: idxFile.text, stamp: stamp(t) };
        notes.push(
          `${PROJECT_INDEX_FILE} could not be read (${r.error}). It was rebuilt from the run folders; the old file will be kept as cala-project.corrupt-${corrupt.stamp}.json.`,
        );
      }
    }
    idx = { ...idx, project: { ...idx.project, results_location: location() } };
    setIndex(idx);
    setDirty(changed);
    setWarnings(notes);
    // Saved now when writing is already allowed (a reopened project), else at the next change.
    if (changed && canWrite() && (await hasReadwrite(resultsHandle() ?? o.handle))) await save(idx);
  }

  /** Write the index, if this browser can and the index is ours to change. */
  async function save(idx: ProjectIndex): Promise<void> {
    setIndex(idx);
    if (readOnly() || !canWrite()) {
      setDirty(true);
      return;
    }
    await writeIndex(await resultsDirForWrite(), idx, corrupt);
    corrupt = null;
    setDirty(false);
  }

  async function open(o: ProjectOpen): Promise<void> {
    setLoading(true);
    setError(null);
    setOpened(o);
    setResultsHandle(o.resultsHandle ?? null);
    setSelected(new Set<string>());
    setPlan([]);
    setPlanState({ kind: 'idle' });
    setIndex(null);
    try {
      const [starts, probed] = await Promise.all([
        Promise.all(o.sessions.map(readStartMs)),
        deps
          .probe(o.sessions.map(toSessionInput))
          .catch((err: unknown) =>
            o.sessions.map(() => ({ error: err instanceof Error ? err.message : String(err) })),
          ),
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
            },
          };
        }),
      );
      await loadIndex();
      if (o.handle && deps.recent)
        await rememberProject(deps.recent, o.handle, o.resultsHandle ?? null, now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  /** Read the results again (after a run; the scan stays). */
  async function refresh(): Promise<void> {
    if (!opened()) return;
    try {
      await loadIndex();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Results go to a folder the user picked (`readwrite` granted by the picker). */
  async function useResultsFolder(handle: ReadDirLike): Promise<void> {
    setResultsHandle(handle);
    const o = opened();
    if (o?.handle && deps.recent) await rememberProject(deps.recent, o.handle, handle, now());
    await refresh();
  }

  function close(): void {
    setOpened(null);
    setRows([]);
    setIndex(null);
    setWarnings([]);
    setPlan([]);
    setSelected(new Set<string>());
    setResultsHandle(null);
    setPlanState({ kind: 'idle' });
  }

  // ---- Table ----

  /** Table rows: the index's sessions (missing ones included) in its order. */
  const tableRows = () => {
    const idx = index();
    if (!idx) return [];
    const byId = new Map(rows().map((r) => [projectSessionId(r.candidate.dir), r]));
    return idx.sessions.map((s) => ({
      session: s,
      row: byId.get(s.id) ?? null,
      status: sessionStatus(idx, s.id),
    }));
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

  async function setCurrent(session: string, run: string): Promise<void> {
    const idx = index();
    if (!idx) return;
    setError(null);
    try {
      if (canWrite() && !readOnly() && !(await grant()))
        throw new Error('The browser did not allow writing to the results folder.');
      const next = setCurrentIn(idx, session, run);
      await save({ ...next, project: { ...next.project, updated: now().toISOString() } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // ---- Run plan ----

  const order = () => tableRows().map((r) => r.session.id);
  function addToPlan(kind: GroupKind): void {
    const ids = [...selected()].filter((id) =>
      tableRows().some((r) => r.session.id === id && r.row),
    );
    if (ids.length === 0) return;
    setPlan(addGroup(plan(), kind, ids, order()));
    setSelected(new Set<string>());
  }

  /**
   * A Joint chain's boundary failed: put its sessions (those still in the
   * table) into the plan as Separate runs. Only edits the plan; nothing runs.
   */
  function replanSeparate(ids: readonly string[]): void {
    const keep = ids.filter((id) => tableRows().some((r) => r.session.id === id && r.row));
    if (keep.length === 0) return;
    setPlan(addGroup(plan(), 'separate', keep, order()));
  }

  /** Problems that keep the plan from starting, per group. */
  function planErrors(): string[] {
    const out: string[] = [];
    const byId = new Map(rows().map((r) => [projectSessionId(r.candidate.dir), r]));
    plan().forEach((g, gi) => {
      const list = g.sessions.map((id) => byId.get(id));
      for (const [i, r] of list.entries()) {
        if (!r) out.push(`Group ${gi + 1}: ${g.sessions[i]} is missing.`);
        else if (r.planned.error) out.push(`Group ${gi + 1}: ${g.sessions[i]}: ${r.planned.error}`);
      }
      if (g.kind === 'joint') {
        const ok = list.filter((r) => r?.planned.info);
        const v = validateSessions(
          ok.map((r) => ({
            name: projectSessionId(r!.candidate.dir),
            width: r!.planned.info!.width,
            height: r!.planned.info!.height,
            bitDepth: r!.planned.info!.bitDepth,
            fps: r!.planned.info!.fps,
          })),
        );
        for (const e of v.errors) out.push(`Group ${gi + 1}: ${e}`);
      }
    });
    return out;
  }

  function plannedFor(ids: string[]): PlannedSession[] {
    const byId = new Map(rows().map((r) => [projectSessionId(r.candidate.dir), r.planned]));
    const list = ids.map((id) => byId.get(id)!).filter(Boolean);
    const paths = uniqueResultsPaths(list.map((p) => p.candidate.dir));
    return list.map((p, i) => ({ ...p, resultsPath: paths[i] }));
  }

  /** The index entries of one group's run, updated as it goes. */
  function progressHandler(runId: string, group: number, groups: number, mode: GroupKind) {
    const stagesBySession = new Map<number, StageRecord[]>();
    let folder = `${RUNS_DIR}/${runId}`;
    return {
      setFolder(f: string) {
        folder = f;
      },
      async onProgress(p: RunProgress): Promise<void> {
        const stages = p.stages.map(stageMeta) as StageRecord[];
        for (const i of p.stagesFor) stagesBySession.set(i, stages);
        let idx = index();
        if (!idx) return;
        const runSessions: ProjectRunSession[] = p.records.map((r) => ({
          id: projectSessionId(r.dir),
          status: r.status,
          ...(r.note ? { note: r.note } : {}),
          stages: stagesBySession.get(r.index) ?? [],
          ...(r.boundary ? { boundary: boundaryFlagJson(r.boundary) } : {}),
        }));
        const run: ProjectRun = {
          id: runId,
          folder,
          mode,
          sessions: runSessions,
          settings: { refine_runs: p.settings.refineRuns },
          app_version: deps.version,
          created: p.createdAt,
          updated: p.updatedAt,
          finished: p.finished,
          ...(p.stopped ? { stopped: p.stopped } : {}),
          plan: { id: planId, group: group + 1, groups },
          library_in: null,
          library_out: null,
        };
        idx = upsertRun(idx, run);
        for (const i of p.written) {
          const r = p.records[i];
          idx = addResult(idx, {
            session: projectSessionId(r.dir),
            run: runId,
            export_path: `${folder}/${r.resultsPath}/${EXPORT_FILE}`,
            cells: p.cellIds?.length ?? null,
            cell_ids: p.cellIds,
            id_space: idSpaceFor(mode, runId, projectSessionId(r.dir)),
            library_version: p.libraryVersion,
            created: p.updatedAt,
          });
        }
        await save({ ...idx, project: { ...idx.project, updated: p.updatedAt } });
      },
    };
  }

  async function startGroup(groups: PlanGroup[], g: number): Promise<void> {
    const group = groups[g];
    const idx = index() ?? emptyIndex(opened()!.rootName, location(), now());
    const runId = runIdFor(now(), new Set(idx.runs.map((r) => r.id)));
    const h = progressHandler(runId, g, groups.length, group.kind);
    const writable = canWrite();
    setPlanState({ kind: 'running', group: g });
    await deps.multiRun.start({
      sessions: plannedFor(group.sessions),
      settings: { mode: group.kind, refineRuns },
      // The sink's root is the full path (`<animal>/cala-results/runs/<id>`).
      locationLabel: writable ? '' : 'a zip download: ',
      planInfo: { id: planId, group: g + 1, groups: groups.length },
      onProgress: (p) => h.onProgress(p),
      openSink: async () => {
        const { sink, folder } = writable
          ? await projectRunSink(await resultsDirForWrite(), runId, location().label)
          : projectZipSink(runId);
        h.setFolder(folder);
        return sink;
      },
    });
  }

  /**
   * Start the plan (inside the Start click: `readwrite` is asked for first).
   * Resolves false when writing was refused.
   */
  async function startPlan(refines: number): Promise<boolean> {
    const groups = plan();
    if (groups.length === 0 || planErrors().length > 0) return false;
    if (!(await grant())) return false;
    refineRuns = refines;
    planId = runIdFor(now(), new Set());
    setRunning(groups);
    await startGroup(groups, 0);
    return true;
  }

  // Groups run one after another: the next starts when the multi-session run finishes.
  createEffect(
    on(
      () => [deps.multiRun.finished(), deps.multiRun.stopped()] as const,
      ([finished, stopped]) => {
        const st = untrack(planState);
        const groups = untrack(running);
        if (st.kind !== 'running' || !groups) return;
        if (!finished && !stopped) return;
        const next = afterGroup(
          groups.length,
          st.group,
          stopped ? { stopped } : { finished: true },
        );
        setPlanState(next);
        if (next.kind === 'running') void startGroup(groups, next.group);
        // Done: the plan is spent. Stopped: the groups not finished stay, to start again.
        if (next.kind === 'done') setPlan([]);
        if (next.kind === 'stopped') setPlan(groups.slice(next.group));
      },
    ),
  );

  return {
    opened,
    rows,
    index,
    tableRows,
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
    plan,
    addToPlan,
    replanSeparate,
    removeGroup: (i: number) => setPlan(removeGroup(plan(), i)),
    moveGroup: (from: number, to: number) => setPlan(moveGroup(plan(), from, to)),
    clearPlan: () => setPlan([]),
    planErrors,
    planState,
    /** The groups of the plan that is running (or ran last). */
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
