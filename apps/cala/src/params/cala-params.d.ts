// Generated from crates/cala/schema/cala-params.schema.json by `npm run gen:params`.
// Do not edit: change the Rust structs in crates/cala/src/params and regenerate.

/** The params layout version this file describes. */
export type CalaParamsVersion = 1;

/**
 * All run parameters of cala.
 */
export interface CalaParams {
  /**
   * The microscope's optics: they turn sizes at the sample into pixels.
   */
  optics: Optics;
  /**
   * Spatial scales: the expected cell diameter and the sizes that follow it.
   */
  scales: Scales;
  /**
   * The recording's frame rate.
   */
  time: Time;
  /**
   * Which part of the frame is processed.
   */
  input: Input;
  /**
   * Footprints a run starts from.
   */
  seed: Seed;
  /**
   * Which stages run.
   */
  stages: Stages;
  /**
   * Calibration, flicker, line and background corrections of each frame.
   */
  preprocess: Preprocess;
  /**
   * Motion correction.
   */
  motion: Motion;
  /**
   * The sensor flat field estimated from the recording's own motion.
   */
  flat_field: FlatField;
  /**
   * Cell discovery (the slow loop).
   */
  discover: Discover;
  /**
   * Re-reading past frames for the slow loop during Discover.
   */
  lookback: Lookback;
  /**
   * Background settle and Final settle.
   */
  settle: Settle;
  /**
   * The per-frame trace solve.
   */
  trace: Trace;
  /**
   * Online quality control of the cells.
   */
  qc: Qc;
  /**
   * Windowed low-rank factors of the preprocessed frames.
   */
  factors: Factors;
  /**
   * What is written to the export.
   */
  export: Export;
  /**
   * How much compute the run uses, and whether its results may depend on it.
   */
  compute: Compute;
}

/**
 * The microscope's optics. The size of one frame pixel at the sample is `sensor_pixel_um × binning ÷ magnification`.
 */
export interface Optics {
  /**
   * Side of one sensor pixel. `null`: not known.
   * Unit: um.
   */
  sensor_pixel_um: number | null;
  /**
   * Magnification from the sample to the sensor. `null`: not known.
   * Unit: ratio.
   */
  magnification: number | null;
  /**
   * Sensor pixels per frame pixel along each side. `null`: the sensor width over the frame width when the sensor width is known, else 1.
   * Unit: count.
   */
  binning: number | null;
  /**
   * Width of the full sensor. `null`: not known.
   * Unit: px.
   */
  sensor_width_px: number | null;
}

/**
 * Spatial scales. Every cell-scale pixel size in the engine follows the expected cell diameter.
 */
export interface Scales {
  /**
   * The diameter of the largest cells you expect, at the sample. With the optics known it gives the diameter in pixels; it is used when `cell_diameter_px` is `null`. `null`: not given.
   * Unit: um.
   */
  expected_cell_diameter_um: number | null;
  /**
   * The expected cell diameter in pixels, set directly. When set it overrides the diameter derived from `expected_cell_diameter_um` and the optics. Flattening, detection and every cell-scale radius follow the resolved diameter. `null`: derived from the physical diameter.
   * Unit: px.
   */
  cell_diameter_px: number | null;
  /**
   * Whether the cell diameter is estimated from the data during the run; the expected diameter is then its starting value.
   */
  adapt: ScaleAdapt;
  /**
   * The optics' point-spread σ: light is smoothed at this scale before a footprint's support is traced.
   * Unit: px.
   */
  psf_sigma_px: number;
  /**
   * σ of the flattening low-pass, in cell diameters.
   * Unit: d.
   */
  flatten_sigma_per_d: number;
  /**
   * σ of the flattening low-pass in pixels; overrides the rule above. `null`: `flatten_sigma_per_d` × the cell diameter.
   * Unit: px.
   */
  flatten_sigma_px: number | null;
}

/**
 * How the cell diameter follows the data.
 */
export type ScaleAdapt = 'off' | 'global' | 'local';

/**
 * The recording's frame rate.
 */
export interface Time {
  /**
   * The frame rate to use instead of the one read from the file; for a file that has none or a wrong one. `null`: the file's frame rate.
   * Unit: Hz.
   */
  fps_override: number | null;
  /**
   * The frame rate at which the durations the engine counts in fixed frames are converted. `null`: the recording's frame rate.
   * Unit: Hz.
   */
  legacy_frame_fps: number | null;
}

/**
 * Which part of the frame is processed.
 */
export interface Input {
  /**
   * The rectangle of the motion-corrected frame that is processed. `null`: the full frame.
   * Unit: px.
   */
  crop: CropRect | null;
}

/**
 * A rectangle of the frame, in pixels from the top-left corner.
 */
export interface CropRect {
  /**
   * Left edge, px.
   */
  x: number;
  /**
   * Top edge, px.
   */
  y: number;
  /**
   * Width, px.
   */
  width: number;
  /**
   * Height, px.
   */
  height: number;
}

/**
 * Footprints a run starts from.
 */
export interface Seed {
  /**
   * The past run whose footprints the run starts from. `null`: start from an empty library.
   */
  from: string | null;
  /**
   * Which of that run's cells are taken.
   */
  select: SeedSelect;
  /**
   * The cell ids taken when `select` is `ids`.
   */
  ids: number[];
}

/**
 * Which cells of a seed run are taken.
 */
export type SeedSelect = 'all' | 'qc_pass' | 'ids';

/**
 * Which stages run.
 */
export interface Stages {
  /**
   * Look for new cells during Discover. Off: only the seed footprints are refined and traced.
   */
  find_new_cells: boolean;
  /**
   * Run Extract after Discover: final traces of every frame with the footprints frozen.
   */
  extract: boolean;
}

/**
 * Calibration, flicker, line and background corrections of each frame.
 */
export interface Preprocess {
  /**
   * Time at the start of the recording used for the calibration (field of view, hot pixels, first noise map).
   * Unit: s.
   */
  warmup_s: number;
  /**
   * Which flicker components are removed from each frame.
   */
  flicker: Flicker;
  /**
   * Which line artifacts are removed from each frame.
   */
  lines: Lines;
  /**
   * The lens field of view.
   */
  fov: Fov;
  /**
   * A pixel is hot or cold when it differs from its neighbourhood by this many noise σ.
   * Unit: sigma.
   */
  hot_pixel_k_sigma: number;
  /**
   * The background floor subtracted from each pixel.
   */
  background: Background;
}

/**
 * Which flicker components are removed.
 */
export type Flicker = 'off' | 'additive' | 'multiplicative' | 'both';

/**
 * Which line artifacts are removed.
 */
export type Lines = 'off' | 'rows' | 'columns' | 'both';

/**
 * The lens field of view.
 */
export interface Fov {
  /**
   * A pixel is inside the field of view when its mean brightness is at least this share of the bright end of the frame.
   * Unit: ratio.
   */
  rel_threshold: number;
  /**
   * Fit a disk to the field of view instead of keeping its traced shape.
   */
  fit_disk: boolean;
  /**
   * Pixels removed from the field of view's edge.
   * Unit: px.
   */
  margin_px: number;
}

/**
 * The background floor subtracted from each pixel.
 */
export interface Background {
  /**
   * Length of the running-mean boxcar the floor is tracked on.
   * Unit: s.
   */
  boxcar_s: number;
  /**
   * Time constant of the floor's upward relaxation.
   * Unit: s.
   */
  relax_s: number;
}

/**
 * Motion correction.
 */
export interface Motion {
  /**
   * The largest rigid shift searched.
   * Unit: px.
   */
  max_shift_px: number;
  /**
   * Time constant of the registration template's running average. 0 keeps the warm-up template.
   * Unit: s.
   */
  template_tau_s: number;
  /**
   * Time between updates of the registration template.
   * Unit: s.
   */
  template_refresh_s: number;
  /**
   * Time averaged into the first registration template.
   * Unit: s.
   */
  warmup_s: number;
  /**
   * Piecewise-rigid registration on a grid of patches.
   */
  nonrigid: NonRigid;
  /**
   * At a session boundary of a Joint run, re-register the new session and carry the preprocessing state into it.
   */
  session_fix: boolean;
}

/**
 * Piecewise-rigid registration on a grid of patches.
 */
export interface NonRigid {
  /**
   * Refine the rigid shift per patch.
   */
  enabled: boolean;
  /**
   * Patches per side of the grid.
   * Unit: count.
   */
  grid: number;
  /**
   * The largest shift of a patch beyond the rigid shift.
   * Unit: px.
   */
  max_patch_shift_px: number;
}

/**
 * The sensor flat field estimated from the recording's own motion.
 */
export interface FlatField {
  /**
   * Estimate the sensor's per-pixel gain and divide it out.
   */
  enabled: boolean;
  /**
   * Half-life of the gain estimate's forgetting.
   * Unit: s.
   */
  gain_half_life_s: number;
  /**
   * Half-life of the offset estimate's forgetting.
   * Unit: s.
   */
  offset_half_life_s: number;
  /**
   * Recording time before the first gain map.
   * Unit: s.
   */
  first_map_s: number;
  /**
   * Recording time between later gain maps.
   * Unit: s.
   */
  refine_every_s: number;
}

/**
 * Cell discovery (the slow loop).
 */
export interface Discover {
  /**
   * A new cell must improve the held-out fit over a noise column by this many standard deviations of that null.
   * Unit: sigma.
   */
  accept_z: number;
  /**
   * A trace value counts as an event above this many noise σ.
   * Unit: sigma.
   */
  event_z: number;
  /**
   * Held-out events a new cell needs.
   * Unit: count.
   */
  min_events: number;
  /**
   * Shortest transient that counts as an event.
   * Unit: s.
   */
  event_s: number;
  /**
   * A cell with no event in this time after its birth is deleted.
   * Unit: s.
   */
  probation_s: number;
  /**
   * Half-life of the running footprint statistics.
   * Unit: s.
   */
  stats_half_life_s: number;
  /**
   * Base cooldown of a spot where a proposed cell was rejected.
   * Unit: s.
   */
  reject_cooldown_s: number;
  /**
   * Half-life of an event slot's priority in the reservoir.
   * Unit: s.
   */
  event_half_life_s: number;
  /**
   * Shortest time between two keep-test probes of one cell.
   * Unit: s.
   */
  probe_gap_s: number;
  /**
   * A cell is refined from the reservoir only within this time after its birth; later, from its running statistics alone.
   * Unit: s.
   */
  reservoir_refine_s: number;
  /**
   * Merge tests.
   */
  merge: Merge;
  /**
   * The joint footprint update of overlapping cells.
   */
  cluster: Cluster;
  /**
   * The local background ring of each footprint.
   */
  ring: Ring;
  /**
   * Side of a slow-loop tile.
   * Unit: px.
   */
  tile_px: number;
  /**
   * Margin stored around each tile. `null`: derived from the cell diameter.
   * Unit: px.
   */
  margin_px: number | null;
  /**
   * Frames stored per tile for the add, merge and keep tests.
   * Unit: frames.
   */
  frames_per_tile: number;
  /**
   * Memory cap of the frame reservoir; fewer frames per tile are kept when the full count does not fit.
   * Unit: MB.
   */
  reservoir_max_mb: number;
  /**
   * How often tiles are visited.
   */
  visit: Visit;
  /**
   * Fast-loop work units per frame the slow loop paces itself against.
   * Unit: work_per_frame.
   */
  budget: number;
  /**
   * Fewest frames between two published library versions.
   * Unit: frames.
   */
  commit_interval_frames: number;
  /**
   * Seed of the held-out split and the reservoir's random sample.
   */
  seed: number;
  /**
   * Family-wise error rate of one support construction: the chance that it admits at least one pixel without light.
   * Unit: ratio.
   */
  support_alpha: number;
  /**
   * Refinements from the running statistics.
   */
  refine: Refine;
  /**
   * The background model of the published libraries.
   */
  background: BackgroundModel;
  /**
   * Start each solve in a visit's comparisons at the reference model's solution.
   */
  warm_start: boolean;
  /**
   * Classification of adds as new, re-added or churned (display only).
   */
  churn: Churn;
}

/**
 * Merge tests.
 */
export interface Merge {
  /**
   * Trace correlation above which a merge of two cells is tested.
   * Unit: r.
   */
  corr: number;
  /**
   * Two cells are kept apart when separating them beats the best single cell on held-out frames by this many standard deviations.
   * Unit: sigma.
   */
  z: number;
  /**
   * Which merge tests may merge.
   */
  rule: MergeRule;
  /**
   * Pairs whose centres are at least this many cell diameters apart get the shape gate whatever their overlap. `null`: off.
   * Unit: d.
   */
  guard_min_sep_d: number | null;
  /**
   * The neighbour guards of a merge test apply to pairs whose footprints overlap (cosine) by less than this.
   * Unit: ratio.
   */
  guard_max_ovl: number;
  /**
   * The same bound for the refitted-pair baseline alone.
   * Unit: ratio.
   */
  refit_max_ovl: number;
}

/**
 * Which merge tests may merge.
 */
export type MergeRule = 'legacy' | 'split_half';

/**
 * The joint footprint update of overlapping cells.
 */
export interface Cluster {
  /**
   * Where overlapping cells are refitted jointly from a replay of their stored history.
   */
  update: ClusterUpdate;
  /**
   * Sign rule of the joint footprint step.
   */
  sign: ClusterSign;
  /**
   * Cells join a cluster along whitened overlaps of at least this.
   * Unit: r.
   */
  rho_min: number;
  /**
   * Most cells per cluster.
   * Unit: cells.
   */
  max: number;
  /**
   * Alternations per replay.
   * Unit: count.
   */
  iters: number;
  /**
   * Which members of a replayed cluster are proposed.
   */
  admit: ClusterAdmit;
  /**
   * Carry the store's own joint estimate from one replay to the next.
   */
  carry: boolean;
  /**
   * L1 weight of the replay's trace step, in trace-noise σ.
   * Unit: sigma.
   */
  l1: number;
  /**
   * In the add test, also check the candidate's trace against the nearby cells' traces jointly.
   */
  neighbours: boolean;
}

/**
 * Where overlapping cells are refitted jointly.
 */
export type ClusterUpdate = 'off' | 'refine' | 'all';

/**
 * Sign rule of the joint footprint step.
 */
export type ClusterSign = 'off' | 'own' | 'all';

/**
 * Which members of a replayed cluster are proposed.
 */
export type ClusterAdmit = 'cluster' | 'member';

/**
 * The local background ring of each footprint.
 */
export interface Ring {
  /**
   * Inner radius of the ring, in cell diameters.
   * Unit: d.
   */
  inner_per_d: number;
  /**
   * Outer radius of the ring, in cell diameters.
   * Unit: d.
   */
  outer_per_d: number;
}

/**
 * How often tiles are visited.
 */
export interface Visit {
  /**
   * Fixed: always the target rate. Auto: lower while visits stop finding new cells.
   */
  mode: VisitMode;
  /**
   * Tile visits per Discover frame.
   * Unit: visits_per_frame.
   */
  target: number;
}

/**
 * The Discover visit schedule.
 */
export type VisitMode = 'fixed' | 'auto';

/**
 * Refinements from the running statistics.
 */
export interface Refine {
  /**
   * When the statistics path proposes a refinement.
   */
  gate: RefineGate;
  /**
   * A refinement is accepted when its held-out gains have a paired z above this.
   * Unit: sigma.
   */
  z: number;
}

/**
 * When the statistics path proposes a refinement.
 */
export type RefineGate = 'legacy' | 'split_half';

/**
 * The background model of the published libraries.
 */
export type BackgroundModel = 'none' | 'ring';

/**
 * Classification of adds (display only; changes no decision).
 */
export interface Churn {
  /**
   * Removed cells are remembered this long for the re-add test.
   * Unit: s.
   */
  readd_window_s: number;
  /**
   * A cell removed within this time of its add is churn.
   * Unit: s.
   */
  churn_s: number;
}

/**
 * Re-reading past frames for the slow loop during Discover.
 */
export interface Lookback {
  /**
   * Re-read earlier frames of the recording for each new cell.
   */
  enabled: boolean;
  /**
   * How far before a cell's birth its frames are re-read.
   * Unit: s.
   */
  horizon_s: number;
  /**
   * Look-back frames read per Discover frame.
   * Unit: ratio.
   */
  rate: number;
}

/**
 * Background settle and Final settle.
 */
export interface Settle {
  /**
   * Background settle during Discover.
   */
  background: BackgroundSettle;
  /**
   * The Final settle at the end of Discover.
   */
  final: FinalSettle;
  /**
   * The slow-loop options of a Final settle on factors.
   */
  on_factors: OnFactors;
}

/**
 * Background settle during Discover.
 */
export interface BackgroundSettle {
  /**
   * Most frames re-read per live frame to settle footprints. 0: off.
   * Unit: ratio.
   */
  cap: 0 | 0.5 | 1 | 2;
}

/**
 * The Final settle at the end of Discover.
 */
export interface FinalSettle {
  /**
   * How much of the final settle pass is read.
   */
  level: FinalSettleLevel;
  /**
   * The most recording time the pass reads; a longer recording is sampled in blocks. `null`: three footprint-statistics half-lives.
   * Unit: s.
   */
  max_s: number | null;
}

/**
 * How much of the final settle pass is read.
 */
export type FinalSettleLevel = 'thorough' | 'standard' | 'quick';

/**
 * The slow-loop options of a Final settle on factors.
 */
export interface OnFactors {
  /**
   * Where overlapping cells are refitted jointly.
   */
  cluster_update: ClusterUpdate;
  /**
   * The merge guard separation on factors. `null`: off.
   * Unit: d.
   */
  guard_min_sep_d: number | null;
}

/**
 * The per-frame trace solve.
 */
export interface Trace {
  /**
   * A solve has converged when a sweep moves no trace by more than this share of its noise σ.
   * Unit: ratio.
   */
  tol: number;
  /**
   * Most sweeps per frame.
   * Unit: count.
   */
  max_sweeps: number;
}

/**
 * Online quality control of the cells.
 */
export interface Qc {
  /**
   * Compute the per-cell QC during the run.
   */
  enabled: boolean;
  /**
   * The per-cell pass rule.
   */
  pass: PassRule;
}

/**
 * The per-cell pass rule.
 */
export interface PassRule {
  /**
   * Smallest peak SNR of a passing cell.
   * Unit: ratio.
   */
  min_snr: number;
  /**
   * Trace correlation above which two overlapping cells are a correlated pair.
   * Unit: r.
   */
  pair_r: number;
  /**
   * Share of a trace's variance explained by the frame's shift above which the cell is flagged as following motion.
   * Unit: ratio.
   */
  motion_r2_flag: number;
}

/**
 * Windowed low-rank factors of the preprocessed frames.
 */
export interface Factors {
  /**
   * Where factors come from and how they are used.
   */
  mode: FactorsMode;
  /**
   * Length of one factor window.
   * Unit: s.
   */
  window_s: number;
}

/**
 * Where factors come from and how they are used.
 */
export type FactorsMode = 'auto' | 'off' | 'plain' | 'file' | 'gpu';

/**
 * What is written to the export.
 */
export interface Export {
  /**
   * Export only the cells that pass QC.
   */
  pass_qc_only: boolean;
}

/**
 * How much compute the run uses.
 */
export interface Compute {
  /**
   * The run does the same work at any speed and on any machine, so the same input and settings give the same result.
   */
  repeatable: boolean;
  /**
   * The target processing speed.
   */
  speed: Speed;
  /**
   * Visit workers. `null`: from the machine's core count.
   * Unit: count.
   */
  visit_workers: number | null;
  /**
   * Settle look-back workers besides the first. `null`: from the machine's core count.
   * Unit: count.
   */
  settle_pool: number | null;
  /**
   * Frames per processing batch.
   * Unit: frames.
   */
  batch_frames: number;
}

/**
 * The target processing speed.
 */
export interface Speed {
  /**
   * Max: as fast as the machine goes. Fixed: a target frame rate. Curve: a target that follows a preset curve. Auto: a time budget over Max.
   */
  mode: SpeedMode;
  /**
   * The target in Fixed mode.
   * Unit: Hz.
   */
  fps: number;
  /**
   * The preset curve of Curve mode.
   */
  curve: SpeedCurve;
  /**
   * Auto's time budget: extra time over a Max run, as a share of it.
   * Unit: ratio.
   */
  auto_budget: 0.5 | 1 | 2;
}

/**
 * The speed mode.
 */
export type SpeedMode = 'max' | 'fixed' | 'curve' | 'auto';

/**
 * The preset curves of Curve mode.
 */
export type SpeedCurve = 'find-fast' | 'step-down';
