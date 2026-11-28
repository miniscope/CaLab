# apps/cala: conventions

Repo-wide rules (comment policy, PRs, commands) are in `/CLAUDE.md`. Design docs:
`apps/cala/docs/stages.md`, `apps/cala/docs/run-record.md`, `apps/cala/docs/projects.md`;
analytics: `docs/analytics.md`.
The engine is `crates/cala` (its own `CLAUDE.md`); the only WASM import point is
`src/lib/cala-wasm.ts`.

## Glossary (one term each; use it in code, UI and docs)

| Term                  | Meaning                                                                                                           | Not                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Discover**          | Stage 1: finds cells and builds footprints from an empty library, with live traces                                | pass 1                                                                                       |
| **Final settle**      | End of Discover (recordings): footprints converge with the cell set frozen; levels Thorough/Standard/Quick        | drain, end settle                                                                            |
| **Extract**           | Stage 2: final traces of every frame with footprints frozen                                                       | pass 2 (`pass2` survives in identifiers and keys only)                                       |
| **Refine**            | an edit inside Discover's slow loop. There is no Refine stage                                                     | a stage name                                                                                 |
| **fast loop**         | per-frame trace solve against the current library (`FastLoop`, trace worker)                                      |                                                                                              |
| **slow loop**         | cell discovery: add, merge, refine; publishes library versions (`SlowLoop`, slow worker)                          |                                                                                              |
| **visit**             | one slow-loop pass over a tile; the visit rate is visits per Discover frame (`VISIT_RATE`)                        |                                                                                              |
| **look-back**         | re-reading past frames of the recording for the slow loop (look-back workers)                                     | reservoir replay                                                                             |
| **Background settle** | look-back that settles footprints during Discover when the target speed is below Max. New identifiers: `bgSettle` | concurrent settle, `csettle` (being renamed in code; URL flag and record key `csettle` stay) |
| **footprint**         | a cell's spatial weight map: one contiguous, single-peaked somatic blob                                           | ROI, mask                                                                                    |
| **library**           | the immutable, versioned set of footprints the fast loop solves against                                           |                                                                                              |
| **factors**           | windowed low-rank compression of preprocessed frames, kept in OPFS so past frames can be rebuilt                  | SVD files                                                                                    |
| **run record**        | the reproducibility JSON in every export (`src/lib/run-provenance.ts`, `apps/cala/docs/run-record.md`)            | provenance blob                                                                              |
| **session**           | one recording of a multi-session run; modes **Separate**, **Joint**, **Apply** (`apps/cala/docs/stages.md`)       |                                                                                              |
| **Speed / target**    | the user-set target fps; **Max** = unpaced                                                                        |                                                                                              |

## Workers (`src/workers`, one owner per job)

| Worker                                                                           | Owns                                                                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `frame-worker`                                                                   | stage A: file reads, AVI decode, preprocess front half, flat-field apply                        |
| `motion-worker`                                                                  | stage B: motion correction                                                                      |
| `trace-worker`                                                                   | stage C: preprocess back half, the fast loop, QC, feed to the slow worker                       |
| `slow-worker`                                                                    | the slow loop (`SlowLoop` via `SlowRunner`); hands tile visits to visit workers                 |
| `visit-worker`                                                                   | tile visits; no state between visits besides the noise map                                      |
| `lookback-worker`                                                                | look-back reads for the slow loop, incl. Background settle and Final settle (`LookbackService`) |
| `flat-field-worker`                                                              | the sensor flat field (`FlatFieldEstimator`)                                                    |
| `compress-worker` (+ `compress-helper-worker`)                                   | factors: compression, factor files, Extract on factors                                          |
| `review-worker`, `corr-distance-worker`, `opfs-writer-worker`, `donation-worker` | one job each                                                                                    |

Pipeline wiring: `src/lib/pipeline-stages.ts`. Message conventions:

- Each worker's messages are a discriminated union on `type` in `<name>-types.ts`; add new
  messages there, never as ad-hoc objects.
- Messages carry `session` (slow loop) or `epoch` (stages) so stale replies from a previous run are
  dropped; keep that when adding messages.
- Large buffers are transferred, and pooled buffers come back as `free` acks; never read a buffer
  after transferring it.
- Workers talk over `MessagePort`s the main thread wires; the fast loop never waits for the slow loop.

## Rules the code must respect

- **Fixed display ranges, no auto-contrast.** Images and charts use declared ranges; re-fit is a
  user action. A change in contrast or amplitude must stay visible.
- **Results never silently depend on machine speed.** Any compute budget (target speed, settle
  cap, visit rate, pool sizes) is user-visible or a fixed constant, and is recorded in the run
  record. Schedules key on frames or data (e.g. new cells per visit), never wall time.
- **Real fps for time-based parameters.** Convert seconds to frames with the recording's fps;
  `ASSUMED_FPS` (`src/lib/miniscope-meta.ts`) is only the declared fallback when the file has none.
- **Footprints have no size caps, spatial penalties or sparsity penalties.** A footprint is a
  contiguous single-peaked somatic blob by definition, not by penalty.
- **Converge, don't gate.** Early false cells are tolerated and pruned with accumulating evidence;
  the fast loop is never blocked by the slow loop.
- **Reproducibility record in every export.** A new setting, tunable or URL flag that changes
  results is added to the run record (`src/lib/run-provenance.ts`) and `apps/cala/docs/run-record.md`.
- **Raw data is read-only.** Results go to the project's `cala-results` tree, never into raw folders.
- **Analytics privacy** (`docs/analytics.md`): no file or folder names, paths, animal or session
  names, trace or footprint data, error text or stacks. New events need an entry in that doc.
- **URL flags**: parsed in one place (`src/lib/page-flags.ts` if present; else `KNOWN_FLAGS` /
  `DEBUG_ONLY` in `src/lib/run-provenance.ts`, read in `src/App.tsx`) and listed in `apps/cala/docs/run-record.md`.
  Measurement-only flags require `?debug`.
- Measure performance and memory in headed Chrome with a real GPU; headless hides GPU and memory
  behaviour. Algorithm changes come with an eval (`tools/cala-eval`), multi-seed, before or
  alongside the change.

## UI design language (target; UI PRs are moving to it)

- Lead with visuals for numbers that change during a run (meters, bars, sparklines), not prose;
  at most one sentence per state, explanations in "?" popovers. Live figures update at most at 2 Hz.
- Every range is fixed and declared; "not measured" is a grey dash.
- Stage hues: Discover `#1f75d7`, Final settle `#b8407e`, Extract `#e0701f` (`--stage-*` tokens;
  `STAGE_HUES` in `@calab/ui/palette` for canvas). Work kinds take their stage's hue (`KIND_COLOR`). **Done = the stage's
  full hue + ✓, never green** (green means QC pass / ok). The app accent (violet) is for
  selection and focus only. Status colours always come with an icon and a label.
- No pulsing or decorative motion; respect `prefers-reduced-motion`.
- Colours and spacing come from tokens (`packages/ui/src/styles/tokens.css`), not literals.
- Shared primitives live in `packages/ui`: `MetricTile`, `ProgressBar`, `DashboardPanel`, `Tabs`,
  `SegmentedControl`, `chart/`, and the instruments `Meter`/`MeterRow`, `StageTrack`, `Sparkline`,
  `SegmentedBar`, `RangeBar`, `Legend`, `Badge`, `Icon` (fixed ranges via `range.ts`). Add new
  shared ones there, not in cala. cala keeps only cala-specific compositions (run rail, worker
  squares, FOV overlays). Series colours: `OKABE_ITO` from `@calab/ui/palette`.
- UI changes keep or migrate `data-testid`s used by `e2e/cala*.spec.ts`, and update
  `USER_GUIDE.md` and `screenshot.png` when the screen changes.
