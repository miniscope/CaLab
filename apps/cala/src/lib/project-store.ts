/**
 * The open project (`docs/projects.md`): every source cala opens is one. An animal folder of
 * sessions, a single recording (a project with one session) and a live stream (one session whose
 * stream has the role `live` and no files) differ only in how many streams they have. The store
 * holds the project's sessions, as scanned and probed, its project file (intent: the plan,
 * hand-set current results), the index (a cache rebuilt from the run files) and the actions of
 * the project view. Runs go through the step runner (`multi-run.ts`), one plan step at a time;
 * `ProjectWriter` keeps the files in line as each run file is written.
 */
import { createEffect, createSignal, on, untrack } from 'solid-js';
import { checkLayer, deleteAt, layerEntries, mergeLayer } from '@calab/core';
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
  type FoundRun,
  type IndexFile,
  type IndexStream,
  type PlanState,
  type PlanStep,
  type ProjectFile,
  type ProjectTextFile,
  type ScannedStream,
} from '@calab/project';
import { CALA_PARAMS_VERSION } from '../params/schema.ts';
import { PARAMS_SCHEMA } from './config-file.ts';
import type { BaseLayer } from './param-layers.ts';
import type { ParamsLayer } from './run-params.ts';
import { projectKey, type DraftStore, type RunCopyStore, type SavedRun } from './browser-store.ts';
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
import type { WritableDirLike } from './session-export.ts';
import { ensurePermission } from './fs-handles.ts';
import {
  readStartMs,
  toSessionInput,
  validateSessions,
  type SessionCandidate,
} from './sessions.ts';
import { rememberProject, type RecentStore } from './recent-projects.ts';
import { CALA_APP } from './run-file.ts';
import { errMsg } from './errors.ts';
import { downloadBlob } from './export.ts';

/** What `openProject` opens: a picked folder (or files), or a live stream. */
export interface ProjectOpen {
  rootName: string;
  entries: FolderEntry[];
  /** The picked folder (File System Access API); null when picked through a file input. */
  handle: ReadDirLike | null;
  sessions: SessionCandidate[];
  /** A results folder chosen earlier (recent projects): it holds the project files. */
  resultsHandle?: ReadDirLike | null;
  /**
   * A live stream's URL: the project has one session, `.`, whose stream has the role `live` and
   * no files (`sessions` and `entries` are empty). It has no folder, so its files go into a zip.
   */
  live?: string;
}

/** The session candidate of a live stream: no files, no folder. */
export function liveCandidate(): SessionCandidate {
  return {
    id: 'live',
    dir: '',
    name: 'live stream',
    series: { key: 'live', dir: '', prefix: '', ext: '', files: [] },
    entries: [],
    metaEntries: [],
  };
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
  /** The draft project file while it is not in a folder (IndexedDB; absent: none kept). */
  drafts?: DraftStore;
  /** Copies of the run files that go into zips (OPFS; absent: none kept). */
  runCopies?: RunCopyStore;
  /** The settings layers of the run that starts next (`ParamLayers.setBase`). */
  setBase?: (layers: BaseLayer[]) => void;
  version: string;
  now?: () => Date;
}

/** A params block of the project file as a layer: its schema fields only (null: not a params object). */
function knownLayer(v: unknown): ParamsLayer | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const c = checkLayer(PARAMS_SCHEMA, v);
  return c.errors.length > 0 ? null : (c.known as ParamsLayer);
}

/** The project's cala defaults (empty when it sets none, or they cannot be used). */
function calaDefaults(p: ProjectFile): ParamsLayer {
  const d = p.defaults[CALA_APP];
  if (!d || d.params_version !== CALA_PARAMS_VERSION) return {};
  return knownLayer(d.params) ?? {};
}

/** The stream `ref` of the project file (undefined: not in it). */
function streamOf(p: ProjectFile, ref: string) {
  for (const s of p.sessions)
    for (const x of s.streams) if (streamRef(s.id, x.id) === ref) return x;
  return undefined;
}

/**
 * The settings layers of a run of `refs` made for `step` (`docs/projects.md`, "Settings layers"): the project's defaults,
 * the step's params, and the stream's overrides when the run has that one stream. Empty layers
 * are left out.
 */
export function baseLayers(
  p: ProjectFile,
  step: Pick<PlanStep, 'params'> | null,
  refs: readonly string[],
): BaseLayer[] {
  const out: BaseLayer[] = [
    { tag: 'project', layer: calaDefaults(p) },
    { tag: 'step', layer: knownLayer(step?.params) ?? {} },
  ];
  if (refs.length === 1)
    out.push({
      tag: 'stream',
      layer: knownLayer(streamOf(p, refs[0])?.overrides?.[CALA_APP]) ?? {},
    });
  return out.filter((l) => Object.keys(l.layer).length > 0);
}

/** What in the project file's params blocks cannot be used (for the project's warnings). */
export function layerWarnings(p: ProjectFile): string[] {
  const out: string[] = [];
  const check = (v: unknown, where: string) => {
    if (v === undefined) return;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      out.push(`${where} is not a settings object; not used.`);
      return;
    }
    const c = checkLayer(PARAMS_SCHEMA, v);
    for (const e of c.errors) out.push(`${where}: ${e.pointer} ${e.message} Not used.`);
    for (const u of c.unknown) out.push(`${where}: ${u.pointer} is not a cala setting; not used.`);
  };
  const d = p.defaults[CALA_APP];
  if (d && d.params_version !== CALA_PARAMS_VERSION)
    out.push(
      `The project's cala defaults are params version ${d.params_version}; this cala reads ${CALA_PARAMS_VERSION}, so they are not used.`,
    );
  else if (d) check(d.params, 'Project defaults');
  for (const s of p.plan.steps) check(s.params, `Plan step ${s.id}`);
  for (const s of p.sessions)
    for (const x of s.streams) check(x.overrides?.[CALA_APP], `${streamRef(s.id, x.id)} overrides`);
  return out;
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
      /**
       * The project file is not in a folder (`project`: keep it in browser storage), or it was
       * just written to one (null: drop what is kept).
       */
      mirror?: (project: ProjectFile | null) => Promise<void>;
      /** A run file that went into a zip: keep its copy (`text`), or drop it (null: it ended). */
      runCopy?: (id: string, text: string | null) => Promise<void>;
      /** A run file that went into a zip, as written now (the folder never holds it). */
      zipRun?: (run: FoundRun) => void;
    },
  ) {}

  private async mirror(onDisk: boolean): Promise<void> {
    if (this.o.readOnly || !this.o.mirror) return;
    try {
      await this.o.mirror(onDisk ? null : this.project);
    } catch {
      // Browser storage is a convenience: a failure never stops a save.
    }
  }

  /** Write both files (the project file only when it is ours to change). */
  async save(): Promise<void> {
    this.o.onChange?.();
    if (!this.o.dir) {
      await this.mirror(false);
      return;
    }
    await writeProject(await this.o.dir(), this.o.readOnly ? null : this.project, this.index);
    await this.mirror(true);
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
      this.o.zipRun?.({ run: p.run, folder: p.folder });
      this.o.onChange?.();
      if (!this.o.readOnly)
        await p.sink.writeProjectText(PROJECT_FILE, fileText('project', this.project));
      await p.sink.writeProjectText(INDEX_FILE, fileText('index', this.index));
      await this.mirror(false);
      // The zip downloads when the run ends: until then its run file is kept in the browser.
      const st = p.run.run.status;
      const ended = st === 'finished' || st === 'stopped';
      try {
        await this.o.runCopy?.(p.run.run.id, ended ? null : fileText('run', p.run));
      } catch {
        // Best effort, as above.
      }
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
  /** The run files this page wrote into zips since the project was opened, by run id. */
  const zipRuns = new Map<string, FoundRun>();
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
  /** What was opened, for analytics: a new object for each open (null: none, or it failed). */
  const [summary, setSummary] = createSignal<{
    sessions: number;
    live: boolean;
    existing: boolean;
  } | null>(null);
  let writer: ProjectWriter | null = null;
  /** The run whose settings layers are in force: its plan step and streams (null: none). */
  const [layersFor, setLayersFor] = createSignal<{ step: string | null; refs: string[] } | null>(
    null,
  );
  /** Run files kept in browser storage from runs that never ended (a crash, a closed tab). */
  const [savedRuns, setSavedRuns] = createSignal<SavedRun[]>([]);
  /** The project file came from browser storage at this open (it was not in the folder). */
  const [fromDraft, setFromDraft] = createSignal(false);
  /** This project's key in browser storage (null: none open). */
  const storeKey = (): string | null => {
    const o = opened();
    if (!o) return null;
    // Each stream with its first video's size and date: two recordings in folders of the same
    // name (every Miniscope's is `My_V4_Miniscope`) do not share a draft.
    return projectKey(
      o.live ? `${o.rootName}@${o.live}` : o.rootName,
      rows().map((r) => {
        const f = (r.candidate.series.files[0]?.entry as { file?: File } | undefined)?.file;
        return f ? `${r.planned.stream}:${f.size}:${f.lastModified}` : r.planned.stream;
      }),
    );
  };

  const location = () => {
    const custom = resultsHandle();
    const root = opened()?.rootName ?? '';
    return custom
      ? { kind: 'custom' as const, label: custom.name }
      : { kind: 'default' as const, label: `${root}/${PROJECT_DIR}` };
  };
  /** Writing to the folder was declined at a Start: the runs go into zips until the next open. */
  const [declined, setDeclined] = createSignal(false);
  /** Results can be written to a folder (File System Access API, and not declined). */
  const canWrite = () =>
    !declined() &&
    opened()?.handle != null &&
    typeof opened()?.handle?.getDirectoryHandle === 'function';

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
      role: p.live ? 'live' : 'miniscope',
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
      mirror: async (proj) => {
        const key = storeKey();
        if (!key || !deps.drafts) return;
        if (proj) await deps.drafts.put(key, proj);
        else await deps.drafts.remove(key);
      },
      zipRun: (r) => zipRuns.set(r.run.run.id, r),
      runCopy: async (id, text) => {
        const key = storeKey();
        if (!key || !deps.runCopies) return;
        if (text !== null) await deps.runCopies.save(key, id, text);
        else await deps.runCopies.remove(key, id);
      },
    });
  }

  /**
   * The draft of this project kept in browser storage, when it is newer than `p` (the folder's
   * file, or a new one): it holds a plan, defaults or overrides not yet written to the folder.
   */
  async function newerDraft(p: ProjectFile, inFolder: boolean): Promise<ProjectFile | null> {
    const key = storeKey();
    if (!key || !deps.drafts) return null;
    let d: ProjectFile | null;
    try {
      d = await deps.drafts.get(key);
    } catch {
      return null;
    }
    if (!d) return null;
    if (!inFolder) return d;
    return d.project.id === p.project.id && d.project.updated > p.project.updated ? d : null;
  }

  /** Point the settings layers at a run of `refs` for plan step `stepId`. */
  function applyLayers(stepId: string | null, refs: readonly string[]): void {
    setLayersFor({ step: stepId, refs: [...refs] });
    const p = writer?.project;
    if (!p) return;
    const step = stepId ? (p.plan.steps.find((s) => s.id === stepId) ?? null) : null;
    deps.setBase?.(baseLayers(p, step, refs));
  }

  /**
   * Read the project file and the run files; rebuild the index; bring both in line with the scan.
   * Resolves whether the folder had a project file.
   */
  async function load(fresh = false): Promise<boolean> {
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
    if (!readOnly()) {
      const draft = await newerDraft(p, pf !== undefined);
      if (draft) {
        p = draft;
        changed = true;
        notes.push(
          pf
            ? 'Changes not yet written to the project folder were restored from browser storage.'
            : 'The project file was restored from browser storage (this browser cannot write it to the folder before a run).',
        );
      }
      setFromDraft(draft !== null);
    }
    // At an open no run is going: a step left running (a crash, a closed tab) has stopped.
    if (fresh && !readOnly()) {
      for (const st of p.plan.steps)
        if (st.status === 'running') {
          p = { ...p, plan: stepStopped(p.plan, st.id) };
          changed = true;
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
    notes.push(...layerWarnings(p));
    const found = findRunFiles(files);
    for (const f of found.refused) notes.push(`${f.path}: ${f.error}`);
    // Only at an open: on a refresh a zip run of this page may be going, its copy current.
    if (fresh) await loadSavedRuns(new Set(found.runs.map((r) => r.run.run.id)));
    // Runs this page wrote into zips are in no folder it can read: a refresh keeps them.
    if (fresh) zipRuns.clear();
    const onDisk = new Set(found.runs.map((r) => r.run.run.id));
    const runs = [...found.runs, ...[...zipRuns.values()].filter((r) => !onDisk.has(r.run.run.id))];
    const idx = rebuildIndex(runs, indexStreams(p, rows()), t);
    if (changed) p = { ...p, project: { ...p.project, updated: t.toISOString() } };
    writer = makeWriter(p, idx);
    setProject(p);
    setIndex(idx);
    setWarnings(notes);
    setDirty(changed);
    // A one-stream project's plan is that stream's run: one Separate step, kept when it is there.
    const one = single();
    if (one && !readOnly()) {
      const before = writer.project.plan;
      writer.project = { ...writer.project, plan: withStepFor([one.planned.stream], before) };
      if (writer.project.plan !== before) {
        setProject(writer.project);
        setDirty(true);
      }
    }
    // Saved at once when writing is already allowed (a reopened project), else at the next change.
    if (canWrite() && (await hasReadwrite(resultsHandle() ?? o.handle))) await persist();
    return pf !== undefined;
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
      if (!readOnly() && deps.drafts) {
        const key = storeKey();
        if (key) await deps.drafts.put(key, writer.project).catch(() => {});
      }
    }
  }

  /**
   * The run files kept in browser storage for this project whose run never ended, except those
   * the folder already holds (`known`). Ended runs' copies are dropped.
   */
  async function loadSavedRuns(known: ReadonlySet<string>): Promise<void> {
    const key = storeKey();
    if (!key || !deps.runCopies) {
      setSavedRuns([]);
      return;
    }
    const keep: SavedRun[] = [];
    for (const r of await deps.runCopies.list(key).catch(() => [] as SavedRun[])) {
      let status: unknown;
      try {
        status = (JSON.parse(r.text) as { run?: { status?: unknown } }).run?.status;
      } catch {
        status = null;
      }
      if (known.has(r.id) || status === 'finished' || status === 'stopped')
        await deps.runCopies.remove(key, r.id).catch(() => {});
      else keep.push(r);
    }
    setSavedRuns(keep);
  }

  /** Download a kept run file (`calab-run.json` of that run). */
  function downloadSavedRun(id: string): void {
    const r = savedRuns().find((x) => x.id === id);
    if (!r) return;
    downloadBlob(`${id}_calab-run.json`, new Blob([r.text], { type: 'application/json' }));
  }

  /** Forget a kept run file. */
  async function forgetSavedRun(id: string): Promise<void> {
    const key = storeKey();
    setSavedRuns(savedRuns().filter((r) => r.id !== id));
    if (key) await deps.runCopies?.remove(key, id).catch(() => {});
  }

  async function open(o: ProjectOpen): Promise<void> {
    setLoading(true);
    setError(null);
    setOpened(o);
    setResultsHandle(o.resultsHandle ?? null);
    setDeclined(false);
    setSelected(new Set<string>());
    setPlanState({ kind: 'idle' });
    setProject(null);
    setIndex(null);
    setSummary(null);
    setSavedRuns([]);
    setLayersFor(null);
    deps.setBase?.([]);
    writer = null;
    try {
      if (o.live) {
        // A live stream is probed by connecting to it, when its run starts.
        const candidate = liveCandidate();
        setRows([
          {
            candidate,
            planned: {
              candidate,
              info: null,
              error: null,
              startMs: null,
              resultsPath: '.',
              stream: '.',
              live: o.live,
            },
          },
        ]);
      } else {
        const [starts, probed] = await Promise.all([
          Promise.all(o.sessions.map(readStartMs)),
          deps
            .probe(o.sessions.map(toSessionInput))
            .catch((err: unknown) => o.sessions.map(() => ({ error: errMsg(err) }))),
        ]);
        setRows(
          o.sessions.map((candidate, i) => {
            const r = probed[i];
            const stream = projectSessionId(candidate.dir);
            return {
              candidate,
              planned: {
                candidate,
                info: r && 'info' in r ? r.info : null,
                error: r && 'error' in r ? r.error : null,
                startMs: starts[i],
                // A run folder holds each stream's results at its stream ref.
                resultsPath: stream,
                stream,
              },
            };
          }),
        );
      }
      const existing = await load(true);
      const one = single();
      if (one && !error()) {
        const ref = one.planned.stream;
        applyLayers(stepFor([ref], writer!.project.plan, 'separate')?.id ?? null, [ref]);
      }
      setSummary({
        sessions: projectStreamRefs(writer!.project).length,
        live: o.live !== undefined,
        existing,
      });
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
    setLayersFor(null);
    deps.setBase?.([]);
    setSavedRuns([]);
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

  /**
   * Save settings into the project file (inside a click): `project` merges `layer` into the
   * project's cala defaults; `stream` into the overrides of the stream whose run the settings
   * are for (one stream only). A value saved as a default leaves that stream's override, so it
   * holds there too. Resolves false when there is nowhere to save.
   */
  async function saveParams(scope: 'project' | 'stream', layer: ParamsLayer): Promise<boolean> {
    const ctx = layersFor();
    if (!writer || readOnly() || !ctx) return false;
    const ref = ctx.refs.length === 1 ? ctx.refs[0] : null;
    if (scope === 'stream' && !ref) return false;
    // Defaults this cala cannot read (another params version, a value out of range) are never
    // written over.
    const d = writer.project.defaults[CALA_APP];
    if (
      scope === 'project' &&
      d &&
      (d.params_version !== CALA_PARAMS_VERSION || knownLayer(d.params) === null)
    ) {
      setError("The project's cala defaults cannot be read here, so they are not changed.");
      return false;
    }
    setError(null);
    // Without permission the file waits in browser storage until a run writes it.
    if (canWrite()) await grant();
    const ptrs = [...layerEntries(PARAMS_SCHEMA, layer).keys()];
    const withOverride = (
      p: ProjectFile,
      f: (o: Record<string, unknown>) => Record<string, unknown>,
    ): ProjectFile => ({
      ...p,
      sessions: p.sessions.map((s) => ({
        ...s,
        streams: s.streams.map((x) => {
          if (streamRef(s.id, x.id) !== ref) return x;
          const { [CALA_APP]: mine, ...others } = x.overrides ?? {};
          const next = f((mine as Record<string, unknown> | undefined) ?? {});
          const overrides = Object.keys(next).length > 0 ? { ...others, [CALA_APP]: next } : others;
          const { overrides: _old, ...rest } = x;
          return Object.keys(overrides).length > 0 ? { ...rest, overrides } : rest;
        }),
      })),
    });
    await edit((p) => {
      if (scope === 'stream') return withOverride(p, (o) => mergeLayer(o, layer));
      const merged = mergeLayer(p.defaults[CALA_APP]?.params ?? {}, layer);
      const next: ProjectFile = {
        ...p,
        defaults: {
          ...p.defaults,
          [CALA_APP]: { params_version: CALA_PARAMS_VERSION, params: merged },
        },
      };
      return ref
        ? withOverride(next, (o) => ptrs.reduce((acc, ptr) => deleteAt(acc, ptr), o))
        : next;
    });
    applyLayers(ctx.step, ctx.refs);
    return true;
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
    const rowOrder = order();
    void edit((p) => ({ ...p, plan: addSteps(p.plan, CALA_APP, kind, ids, rowOrder) }));
    setSelected(new Set<string>());
  }

  /**
   * A Joint chain's boundary failed: put its sessions (those still in the
   * table) into the plan as Separate runs. Only edits the plan; nothing runs.
   */
  function replanSeparate(ids: readonly string[]): void {
    const keep = ids.filter((id) => tableRows().some((r) => r.session.id === id && r.row));
    if (keep.length === 0) return;
    const rowOrder = order();
    void edit((p) => ({ ...p, plan: addSteps(p.plan, CALA_APP, 'separate', keep, rowOrder) }));
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
    return ids.map((id) => byId.get(id)!).filter(Boolean);
  }

  /**
   * The project's one stream when it has exactly one (a single recording or a live stream) and
   * it is here; null otherwise. Such a project opens on its recording, not on the table.
   */
  function single(): ProjectSessionRow | null {
    const p = writer?.project ?? project();
    if (!p || rows().length !== 1) return null;
    return projectStreamRefs(p).length === 1 ? rows()[0] : null;
  }

  /** The runnable step of `kind` over exactly `refs` (a single stream: `separate`), if any. */
  function stepFor(
    refs: readonly string[],
    plan: ProjectFile['plan'],
    kind: 'joint' | 'separate',
  ): PlanStep | undefined {
    const want = refs.length > 1 ? kind : 'separate';
    return runnableSteps(plan).find(
      (s) =>
        s.kind === want &&
        s.streams.length === refs.length &&
        s.streams.every((r, i) => r === refs[i]),
    );
  }

  /** `plan` with a runnable step of `kind` over exactly `refs` (the one there, or a new one). */
  function withStepFor(
    refs: readonly string[],
    plan: ProjectFile['plan'],
    kind: 'joint' | 'separate' = 'separate',
  ): ProjectFile['plan'] {
    if (stepFor(refs, plan, kind)) return plan;
    return addSteps(plan, CALA_APP, refs.length > 1 ? kind : 'separate', refs, refs);
  }

  /**
   * Run `refs` as one step now: the Run button of an open recording, or Restart after its run
   * ended (a new run each time). Inside the click: `readwrite` is asked for first.
   */
  async function runStreams(
    refs: readonly string[],
    kind: 'joint' | 'separate' = 'separate',
  ): Promise<boolean> {
    if (!writer || readOnly() || refs.length === 0) return false;
    writer.project = { ...writer.project, plan: withStepFor(refs, writer.project.plan, kind) };
    setProject(writer.project);
    const step = stepFor(refs, writer.project.plan, kind);
    return step ? startPlan([step.id]) : false;
  }

  async function startStep(steps: PlanStep[], k: number): Promise<void> {
    const step = steps[k];
    const w = writer!;
    const planId = w.project.plan.id!;
    setPlanState({ kind: 'running', step: k });
    await deps.multiRun.start({
      sessions: plannedFor(step.streams),
      kind: modeOf(step),
      // The sink's root is the full path (`<animal>/calab-project/runs/<id>`).
      locationLabel: canWrite() ? '' : 'a zip download: ',
      planRef: () => ({ id: planId, step: step.id, kind: step.kind }),
      beforeSession: (i) =>
        applyLayers(step.id, step.kind === 'joint' ? step.streams : [step.streams[i]]),
      openRun: () => w.openRun(runIdFor(now(), CALA_APP, new Set(w.index.runs.map((r) => r.id)))),
      onProgress: (p) => w.record(p),
    });
  }

  /**
   * Start the plan (inside the Start click: `readwrite` is asked for first). The plan is written
   * to the project file before its first step runs. Resolves false when writing was refused.
   * `only`: run just these steps (by id), in plan order.
   */
  async function startPlan(only?: readonly string[]): Promise<boolean> {
    const steps = runnableSteps(project()?.plan ?? { id: null, steps: [] }).filter(
      (s) => !only || only.includes(s.id),
    );
    if (!writer || steps.length === 0 || planErrors().length > 0) return false;
    // A declined permission still runs: the run goes into a zip, as without the API.
    if (!(await grant())) {
      setDeclined(true);
      writer = makeWriter(writer.project, writer.index);
    }
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
    /** Writing to the folder was declined: runs go into zips. */
    declined,
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
    runStreams,
    single,
    summary,
    saveParams,
    /** This project's key in browser storage (drafts, run copies). */
    storeKey,
    /** The run the settings layers are for (null: none): its step and streams. */
    layersFor,
    /** The project file came from browser storage at this open. */
    fromDraft,
    savedRuns,
    downloadSavedRun,
    forgetSavedRun,
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
