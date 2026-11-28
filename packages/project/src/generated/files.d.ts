// Generated from packages/project/src/schema/*.schema.json by `npm run gen:types -w packages/project`.
// Do not edit: change the schema and regenerate.

/**
 * `calab-project.json`: the intent of a CaLab project (one animal). Authoritative and hand-editable: identity, per-app default params, per-stream overrides, the plan, hand-set current results and the cell-match files.
 */
export interface ProjectFile {
  format: 'calab-project';
  /**
   * Envelope version.
   */
  version: number;
  project: ProjectIdentity;
  /**
   * Every session of the animal, in start-time order.
   */
  sessions: ProjectSession[];
  /**
   * Per app: the project's default params (a partial params object of that app's schema).
   */
  defaults: Record<string, AppDefaults>;
  plan: Plan;
  /**
   * Per app: stream ref -> run id of the result picked by hand. A stream not listed takes the app's newest result.
   */
  current: Record<string, Record<string, string>>;
  /**
   * Cell-match files under `identity/`, by path relative to the project folder.
   */
  identity: string[];
}

export interface ProjectIdentity {
  /**
   * Random, made once (`p-` and 8 hex digits).
   */
  id: string;
  /**
   * For people: the animal folder's name by default.
   */
  name: string;
  subject: Subject;
  /**
   * ISO time.
   */
  created: string;
  /**
   * ISO time.
   */
  updated: string;
}

export interface Subject {
  id: string | null;
  species: string | null;
  notes: string;
}

export interface ProjectSession {
  /**
   * The recording folder below the data root, e.g. `2026_11_10/09_00_00`; `.` for the root.
   */
  id: string;
  /**
   * `recordingStartTime`, ISO.
   */
  start: string | null;
  /**
   * Typed by the user.
   */
  label: string | null;
  streams: ProjectStream[];
}

export interface ProjectStream {
  /**
   * The device folder below the session folder; `.` when the session folder holds the videos.
   */
  id: string;
  /**
   * `miniscope`, `behavior_camera`, `live`, ...
   */
  role: string;
  frames: number | null;
  /**
   * Stream refs it had before a renamed folder was matched to it.
   */
  previous_ids: string[];
  /**
   * Per app: partial params for runs of this stream alone.
   */
  overrides?: Record<string, Record<string, unknown>>;
}

export interface AppDefaults {
  params_version: number;
  params: Record<string, unknown>;
}

export interface Plan {
  /**
   * Set when the plan is first started.
   */
  id: string | null;
  steps: PlanStep[];
}

export interface PlanStep {
  /**
   * Unique within the plan (`a`, `b`, ...).
   */
  id: string;
  app: string;
  /**
   * separate: one stream; joint: one library through several streams; apply: a library from a linked run.
   */
  kind: 'separate' | 'joint' | 'apply';
  /**
   * Stream refs, in run order.
   */
  streams: string[];
  /**
   * Partial params of the app's schema for this step.
   */
  params?: Record<string, unknown>;
  /**
   * What the step's run will link to: a run id, or an earlier step of this plan.
   */
  links?: StepLink[];
  /**
   * A finished step leaves the plan; its run file keeps a copy of the step.
   */
  status: 'pending' | 'running' | 'stopped';
  /**
   * Runs started for this step (a stopped step keeps its stopped run).
   */
  runs: string[];
}

export interface StepLink {
  role: 'seed' | 'library' | 'traces' | 'config';
  run?: string;
  step?: string;
  stream?: string | null;
  [key: string]: unknown;
}

/**
 * `calab-run.json`: the truth of one run of one app (one config, one library). Written before the first frame and at each change; never edited by hand. `run`, `inputs`, `links`, `config`, `stages` and `results` are app-neutral; `derived`, `frame` and `record` belong to the app.
 */
export interface RunFile {
  format: 'calab-run';
  /**
   * Envelope version.
   */
  version: number;
  run: RunHeader;
  inputs: RunInput[];
  links: RunLink[];
  config: RunConfig;
  /**
   * JSON pointer -> what the data set for that param during the run (app-specific).
   */
  derived: Record<string, unknown>;
  /**
   * The frame the results are stored in (app-specific; cala: sensor size and crop).
   */
  frame?: Record<string, unknown> | null;
  stages: RunStage[];
  results: RunResult[];
  /**
   * How the run was made beyond its config: machine, flags, speed, work (app-specific).
   */
  record: Record<string, unknown>;
}

export interface RunHeader {
  /**
   * `<local time>_<app>`, e.g. `2026-11-28_09-14-03_cala`; the run folder's name.
   */
  id: string;
  app: string;
  app_version: string;
  engine_version: string | null;
  git_commit: string | null;
  /**
   * The project's id; null outside a project.
   */
  project: string | null;
  /**
   * The plan step the run was made for.
   */
  plan: RunPlanRef | null;
  status: 'planned' | 'running' | 'finished' | 'stopped';
  /**
   * Why the run stopped.
   */
  stopped: string | null;
  /**
   * ISO time.
   */
  created: string;
  /**
   * ISO time.
   */
  updated: string;
}

export interface RunPlanRef {
  id: string;
  step: string;
  kind: 'separate' | 'joint' | 'apply';
}

export interface RunInput {
  /**
   * `video`, `live`, ...
   */
  role: string;
  /**
   * Stream ref, relative to the data root.
   */
  stream: string;
  recording_start: string | null;
  frames: number | null;
  files?: number | null;
  width: number | null;
  height: number | null;
  bit_depth: number | null;
  fps: RunFps | null;
  /**
   * First frame of this stream on the run's frame axis.
   */
  start_frame: number;
}

export interface RunFps {
  /**
   * Unit: Hz.
   */
  value: number | null;
  /**
   * `timestamps`, `metadata`, `none`, `live`.
   */
  source: string;
}

/**
 * A typed edge to something an earlier run made. Apps may add fields (`select`, `alignment`, ...).
 */
export interface RunLink {
  role: 'seed' | 'library' | 'traces' | 'config';
  run: string;
  stream: string | null;
  artifact?: string;
  id_space?: string;
  source_fingerprint?: string | null;
  [key: string]: unknown;
}

export interface RunConfig {
  /**
   * The app's params schema, e.g. `cala-params`.
   */
  schema: string;
  params_version: number;
  /**
   * Every value any layer set (partial params), including values equal to their default.
   */
  requested: Record<string, unknown>;
  /**
   * JSON pointer -> the layer that set it (`default`, `project`, `step`, `stream`, `file:<name>`, `ui`, `url`).
   */
  sources: Record<string, string>;
  /**
   * JSON pointers of requested keys that are not params of the schema.
   */
  ignored: string[];
  /**
   * The complete params the run was built with.
   */
  resolved: Record<string, unknown>;
  /**
   * Hash of the result-affecting part of `resolved`.
   */
  fingerprint: string | null;
}

export interface RunStage {
  stage: string;
  outcome: string;
  started_at?: string | null;
  ended_at?: string | null;
  [key: string]: unknown;
}

export interface RunResult {
  stream: string;
  status: 'pending' | 'written' | 'skipped' | 'failed';
  /**
   * Why it was skipped or failed.
   */
  note?: string;
  /**
   * The artifact, relative to the run folder; null until written.
   */
  path: string | null;
  /**
   * Where the result's cell ids come from: `<app>:<run id>` for the run's own ids.
   */
  id_space: string;
  cells: number | null;
  library_version: number | null;
  /**
   * [start, end) on the run's frame axis.
   */
  frame_range: number[] | null;
  /**
   * Joint, streams 2..: the health flag of the boundary the stream starts with.
   */
  boundary: Record<string, unknown> | null;
  /**
   * When it was written, ISO.
   */
  created?: string | null;
}

/**
 * `calab-index.json`: a cache of the run files and the stream scan. Safe to delete: it is rebuilt from `runs/*\/calab-run.json`.
 */
export interface IndexFile {
  format: 'calab-index';
  version: number;
  /**
   * ISO time.
   */
  built: string;
  streams: IndexStream[];
  runs: IndexRun[];
  results: IndexResult[];
}

export interface IndexStream {
  ref: string;
  role: string;
  start: string | null;
  frames: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  bit_depth: number | null;
  /**
   * Its folder is gone and no renamed folder matched it.
   */
  missing: boolean;
  previous_refs: string[];
}

export interface IndexRun {
  id: string;
  app: string;
  kind: 'separate' | 'joint' | 'apply';
  status: 'planned' | 'running' | 'finished' | 'stopped';
  /**
   * Relative to the project folder.
   */
  folder: string;
  plan: {
    id: string;
    step: string;
  } | null;
  fingerprint: string | null;
  created: string;
  updated: string;
  stopped: string | null;
  links: {
    role: string;
    run: string;
    stream: string | null;
  }[];
  /**
   * The run's inputs with what became of each.
   */
  streams: IndexRunStream[];
  /**
   * The run's stage log, as its run file has it.
   */
  stages: Record<string, unknown>[];
}

export interface IndexRunStream {
  stream: string;
  status: 'pending' | 'written' | 'skipped' | 'failed';
  note?: string;
  boundary?: Record<string, unknown> | null;
}

export interface IndexResult {
  run: string;
  /**
   * The app of the run that wrote it.
   */
  app: string;
  stream: string;
  /**
   * The artifact, relative to the project folder.
   */
  path: string;
  id_space: string;
  cells: number | null;
  library_version: number | null;
  created: string;
}
