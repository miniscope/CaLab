# Projects

The **project** is the unit of work. Most Miniscope experiments are many
sessions from one animal: cala opens the animal's folder as a project, with
one table of every session, its recording facts and cala status, a plan of runs
over any mix of sessions, and every result kept together in `calab-project/`.

There is one way in. Whatever is opened becomes a project through the same
code path and writes the same files:

| Opened                                            | Project                                                                                        | First screen                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------- |
| An animal folder of sessions                      | one session per recording folder                                                               | the session table                     |
| One recording folder (or files picked one by one) | one session, id `.`; its plan is one Separate step                                             | the recording, with its pre-run sheet |
| A live stream                                     | one session, id `.`, whose stream has the role `live` and no files; no folder (zip at the end) | the recording, running                |

A one-session project never shows its table unless asked (**Project** in the
header). **Run** on its pre-run sheet starts that step: permission to write is
asked, the project file and the run file (`planned`) are written before the
first frame, and the run's results go into its run folder like any other
run's. **Restart** after a run ended starts a new run of the same step.

The project files are app-neutral: `@calab/project` (`packages/project`) owns
their schemas, reading, refusal, the index and the plan, so a later CaDecon,
CaBaNA or behaviour run writes into the same tree. Code on the cala side:
`src/lib/run-file.ts` (cala's run file), `src/lib/project-index.ts` (what the
table shows), `src/lib/project-io.ts` (reading and writing the folder),
`src/lib/project-store.ts` (the open project, its plan and `ProjectWriter`),
`src/lib/recent-projects.ts`, `src/components/ProjectView.tsx`. Every run is the
run of a plan step, through the step runner (`src/lib/multi-run.ts`,
[stages.md](stages.md), "Sessions").

## The project root is the picked folder

**Open a Miniscope folder** on the start screen (or a drop) picks the folder.
The sessions are found by `discoverKinds` and `chooseKind`: every numbered
video series at any depth, the Miniscope kind chosen, behaviour cameras left
out. A session's id is its folder relative to the picked folder, e.g.
`2026_11_10/14_02_33/My_V4_Miniscope`; a folder that holds the videos itself is
the session `.`, and its results sit at the root of each run folder.

### Miniscope or behaviour camera

A behaviour camera writes the same numbered `.avi` files as a Miniscope, so
each device folder's role is read from the metadata the Miniscope DAQ software
writes (`src/lib/device-roles.ts`), strongest first:

1. The recording's `metaData.json` (one folder up) lists its devices,
   `"miniscopes": ["img"]` and `"cameras": ["behav"]`; a device folder is named
   after the device (spaces as `_`).
2. Else the device folder's own `metaData.json`: a `deviceType` naming a
   Miniscope (`Miniscope_V4_BNO`, `Miniscope_V3`) or a camera (`Minicam-Mono-XGA`,
   `WebCam-640x480`), else an `ewl` field (Miniscope only). `gain` and `led0` do
   not tell them apart: a Minicam writes both.
3. Else the names: a `behav*` folder or prefix is a camera, a folder mentioning
   `miniscope` is a Miniscope.

When the metadata says which folders are Miniscopes, only those are sessions;
every other series is left out. A session with two Miniscopes (a dual-scope
rig) gives one row per Miniscope (`14_30_33/scopeL`, `14_30_33/scopeR`), and a
Miniscope folder renamed between days still gives every day. Joint mode
treats every row as the same field of view, so run the scopes of a dual rig as
Separate (or select one scope's rows). Without metadata, camera-named series are
dropped as before and anything still unclear is asked in the series chooser,
which marks the series it takes for a behaviour camera. Where older DAQ
software wrote `msCam*.avi` and `behavCam*.avi` into one folder, that folder's
metadata describes both, so only the names count there.

If the picked folder holds several animals (an experiment folder), the app
offers one project per animal first (`suggestSplit`): at least two top-level
subfolders that each hold at least two sessions and are not named like a
date (`2026_11_10`, `20261110`), a time (`14_02_33`) or a numbered session
(`day3`, `session2`, `7`). The user picks the animal to open, or opens it all as
one project. A folder that already holds `calab-project/calab-project.json` is
never offered a split. With the File System Access API the other animals are
added to Recent projects.

## The three files

```
mouse1/                                        data root: only ever read
  2026_11_10/09_00_00/My_V4_Miniscope/0.avi ...
  calab-project/                               the project folder (default here; or one the user picks)
    calab-project.json                         intent: the project, its sessions, the plan, current picks
    calab-index.json                           cache of the run folders (safe to delete)
    runs/
      2026-11-28_09-14-03_cala/                one run, one library
        calab-run.json                         config, inputs, stages, results, record
        2026_11_10/09_00_00/My_V4_Miniscope/   the stream ref as a path
          cala-export.npz
```

All three are JSON with an envelope: `format` (`calab-project`, `calab-run`,
`calab-index`) and an integer `version`. Each has a JSON Schema in
`packages/project/src/schema/`; the TypeScript types are generated from them
(`npm run gen:types -w @calab/project`) and a drift test keeps the two in line.
Every file is checked against its schema when read and before it is written.

A **stream** is one device's recording in a session; its **ref** is its folder
below the animal folder (`2026_11_10/09_00_00/My_V4_Miniscope`), the session id
plus the stream id. Refs are how every file names a recording.

### `calab-project.json`: intent

Small and hand-editable. It holds what the user decided, which nothing else can
rebuild:

| Key        | What                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `project`  | `id` (`p-` and 8 hex), `name` (the animal folder), `subject` (`id`, `species`, `notes`), `created`, `updated`                              |
| `sessions` | one per session: `id`, `start`, `label`, `streams[]` (`id`, `role`, `frames`, `previous_ids` after a rename, `overrides` per app)          |
| `defaults` | per-app default params (`{cala: {params_version, params}}`)                                                                                |
| `plan`     | `id` (set at Start) and `steps[]`: `id`, `app`, `kind` (`joint`, `separate`, `apply`), `streams`, `params`, `status`, `runs` (its run ids) |
| `current`  | hand-set current results, per app: `{cala: {<stream ref>: <run id>}}`                                                                      |
| `identity` | the list of cell-identity files (reserved)                                                                                                 |

```json
{
  "format": "calab-project",
  "version": 1,
  "project": {
    "id": "p-7f3a9c21",
    "name": "mouse1",
    "subject": { "id": null, "species": null, "notes": "" },
    "created": "2026-11-28T09:10:02.000Z",
    "updated": "2026-11-28T09:13:40.000Z"
  },
  "sessions": [
    {
      "id": "2026_11_10/09_00_00",
      "start": "2026-11-10T09:00:00.000Z",
      "label": null,
      "streams": [
        { "id": "My_V4_Miniscope", "role": "miniscope", "frames": 18000, "previous_ids": [] }
      ]
    },
    {
      "id": "2026_11_11/09_05_12",
      "start": "2026-11-11T09:05:12.000Z",
      "label": null,
      "streams": [
        { "id": "My_V4_Miniscope", "role": "miniscope", "frames": 18000, "previous_ids": [] }
      ]
    }
  ],
  "defaults": {},
  "plan": {
    "id": "2026-11-28_09-13-40",
    "steps": [
      {
        "id": "a",
        "app": "cala",
        "kind": "joint",
        "streams": ["2026_11_10/09_00_00/My_V4_Miniscope", "2026_11_11/09_05_12/My_V4_Miniscope"],
        "status": "running",
        "runs": ["2026-11-28_09-14-03_cala"]
      }
    ]
  },
  "current": {},
  "identity": []
}
```

#### Settings layers

`defaults.cala.params`, a step's `params` and a stream's `overrides.cala` are
partial cala params (any subset of `crates/cala/schema/cala-params.schema.json`).
A run's params resolve, lowest first: schema defaults → project `defaults` →
step `params` → the stream's `overrides` (only when the run has that one
stream: a Separate run, not a Joint one) → a loaded config file → the sheet's
edits. The run file's `config.sources` names the layer of each requested value
(`project`, `step`, `stream`, `file:<name>`, `ui`). In the sheet, **Save as
project defaults** merges the sheet's edits and a loaded file's values into
`defaults` (and drops those keys from the open session's override); with **This
session only** they go into the open stream's `overrides` instead. A block that
breaks the schema, or `defaults` of another params version, is named in a
warning and not used.

### `calab-run.json`: one run

The truth of one run, never edited by hand. One run is one config and one
library: a Joint chain is one run whatever its length, and each Separate
session is a run of its own. It is written **before the run's first frame**
(`status: "planned"`, its config complete), after each result is written
(`running`), and when the run ends (`finished`, or `stopped` with the reason,
also when the run is left or fails).

| Key       | What                                                                                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`     | `id` (`<local time>_cala`, its folder name), `app`, `app_version`, `engine_version`, `git_commit`, `project`, `plan` (`{id, step, kind}`), `status`, `stopped`, `created`, `updated`                                               |
| `inputs`  | one per stream read: `role` (`video`, `live`), `stream`, `recording_start`, `frames`, `files`, `width`, `height`, `bit_depth`, `fps` (`{value, source}`), `start_frame` on the run's frame axis                                    |
| `links`   | other runs this one reads (empty for cala today)                                                                                                                                                                                   |
| `config`  | `schema` (`cala-params`), `params_version`, `requested` (what the sheet or a config file asked for), `sources` (pointer → `ui`, `file:<name>`), `ignored` (unknown keys of a config file), `resolved` (every param), `fingerprint` |
| `derived` | values read from the data (`/time/fps`)                                                                                                                                                                                            |
| `stages`  | the stage log (Discover, Extract) with outcomes and times                                                                                                                                                                          |
| `results` | one per stream: `status` (`pending`, `written`, `skipped`, `failed`), `note`, `path` (below the run folder), `id_space`, `cells`, `library_version`, `frame_range`, `boundary`, `created`                                          |
| `record`  | the rest of the run record ([run-record.md](run-record.md))                                                                                                                                                                        |

Every `cala-export.npz` carries the run file as it was when the export was
written, as `meta_json.run`, so a lone export still says how it was made.

### `calab-index.json`: the cache

The streams the scan found (`ref`, `role`, `start`, `frames`, `fps`, size, bit
depth, `missing`, `previous_refs`), a summary of every run (`id`, `app`,
`kind`, `status`, `folder`, `plan`, `fingerprint`, `streams` with their status
and boundary, `stages`, `links`) and every written result (`run`, `app`,
`stream`, `path` relative to the project folder, `id_space`, `cells`,
`library_version`, `created`). It is rebuilt from the run files and the scan on
every open (`rebuildIndex`), and updated after each run-file write; deleting it
loses nothing.

### Cell identity

`id_space` says where a result's cell ids come from: `cala:<run id>`. A run is
one library, so all its results share one id space; a Joint chain's sessions
share cell ids (cell 7 is the same neuron in each), and each Separate session
has its own. Matching cells across id spaces is not built; `identity/` in the
project folder is where it will go.

The session table's **Cell IDs** column letters the id spaces that several
sessions' current results share (`A`, `B`, ...) and colours those rows'
edges; `own` marks a session with ids of its own.

### Rules

- **The project folder.** `<picked folder>/calab-project/` by default. **Choose
  another folder...** writes to a folder the user picks instead, which then
  plays its role; Recent projects keeps its handle. A raw data folder is only
  ever read.
- **Current result.** Per app and per stream: the one `current` picks by hand
  when that run still has a result for the stream, else the newest. **Set
  current** in a row's results writes the pick to `calab-project.json`.
- **Plan on disk.** Each plan edit (add, move, remove, clear, re-plan) is
  written to `calab-project.json` at once when the browser already allows
  writing; else it is kept in memory and written at **Start plan**, which asks
  for permission and writes the plan (with its id) before the first step runs.
  A step starts with its run (`running`, its run id in `runs`), leaves the plan
  when the run finishes (its run file keeps a copy), and stays, `stopped`, when
  the run stops, to start again.
- **A run folder is never reused.** A suffix is added when the id is taken.
- **Written whole, then swapped in.** A writable stream writes to a swap file
  that replaces the file only on `close()`, so a reader sees the old file or
  the new one, never half.
- **Refusal, never migration of old formats.** A file of an older cala
  (`cala-project.json`, `cala-run.json`, `cala-session.json`,
  `cala-run-record.json`) and an old `<animal>/cala-results/` tree are named in
  a warning and not read; run the sessions again to make new results. A
  `calab-project.json` that cannot be read (bad JSON, a schema error, a newer
  `version`) opens the project read-only: the table shows the runs, nothing
  runs, and the file is never written over. A run file that cannot be read is
  named and left out of the index. Version upgrades of the new files go
  through the migration table in `@calab/project` (empty in version 1).
- **Renamed folders.** A session whose folder is gone is matched to a new
  folder with the same start time and frame count (exactly one candidate); its
  results follow it and the old id goes to `previous_ids`. Unmatched, it stays
  in the table flagged missing.

## The session table

Columns: the session, its date (`recordingStartTime`), its length (frames and
duration), then **Discover** and **Extract**, from the current result's run (else the latest run with that
session, with a note when it was skipped or failed), **Cell IDs**, **Library**
(a placeholder until saved libraries), and the **current result** (run and
cell count). **Results** opens a row's results: each run, when it was made, its
cell count and export path, **View results** and **Set current**. The current
result has **View results** in its cell too.

## View results

**View results** opens a saved result (the session's `cala-export.npz`) in the
normal viewer, read-only, looking as the app did right after a run on that
session: the field of view with the footprints and contours, the QC table and
colours, the selected cell's footprint and trace, the History plots and event
log, the stages that ran, and the flat field. There are no Discover or
Extract controls (a new run starts from the table); **Back to project** returns
to it.

Code: `src/lib/result-file.ts` (reading an export), `src/components/ResultView.tsx`
(the screen), `ProjectStore.resultFile` (finding the file: through the results
folder's handle, or among the files of a folder picked through a file input).

- **The file is read lazily.** `ZipArchive` (`@calab/io`) reads only the
  archive's directory (ZIP64-aware), then each small array as it is needed.
  `traces.npy` is never read whole: it is stored Fortran order (frame-major),
  so a block of frames is one byte range, read about 16 MB at a time into the
  trace viewer's store (the same bounded `TraceHistory` the live viewer uses:
  every cell keeps a whole-session overview, and full-resolution detail up to
  256 MB across all cells). A C-order `traces` (a file re-saved by NumPy) is
  read once and transposed per block.
- **What each panel shows.**
  - Field of view: the export's `fov_mean` and `fov_max` (format 5), each drawn
    with the display range stored with it (fixed from the recording's bit
    depth, never fitted to the pixels: see `src/lib/fov-display.ts`). The lo/hi
    inputs still set a range by hand.
  - Cells: footprints from the CSR arrays, QC from `qc_peak_snr`, `qc_pass`
    and `qc_flags` (the export holds no other QC metric, so the rest of the QC
    table reads n/a; there is no residual map and no demixing neighbours).
    These are the QC recomputed after Extract on that session's own traces,
    over the whole session (`src/lib/extract-qc.ts`), not Discover's last
    minute.
  - Traces: Extract's traces (the live viewer shows Discover's online traces).
  - History and event log: `history_L{k}` and `run_events_json`, read back with
    `StreamHistory.fromExport`. A Joint run's sessions each hold the whole
    run's history, on the run's time axis.
  - Stages: `meta_json.stages`. Flat field: `flat_field_gain` (format 5).
  - Recording: the export's own facts (length, rate, cells, app version,
    format).
- **Older exports open.** Each part a file lacks says "not in this export":
  formats 1 to 4 have no FOV images or flat-field map (the cells are drawn on
  a black field), formats 1 and 2 (before #370) no stage list, and the app
  wrote no History into exports before format 5.

## Run plans

Selected rows go into the **plan** as steps:

- **Run selected jointly**: one Joint step through those sessions in start-time
  order: one run, one library, cell ids shared.
- **Run selected separately**: one Separate step per session: a run and a
  library each.

A session is in one pending step at most (adding it again moves it), and a
Joint step of one session is a Separate step. Steps can be reordered and
removed. **Start plan** asks for permission to write, writes the plan, then
runs the steps one after another; each step is one run (its run file's
`run.plan` names the plan and step), and each session's current result updates
as its results are written. If a stage fails or is cancelled the plan stops:
results already written stay, and the steps not finished stay in the plan to
start again. **Back to project** in the viewer's header returns to the table
(stopping a running plan).

## Live streams

A live stream (**Connect**, or `?live=<url>` on load) is a one-session project
in memory: the session `.`, its stream's role `live`, no files and no folder.
Its run starts on connect; its run file is written (`planned`) before the
first frame, into the run's zip, which downloads when the run ends. The
results are the stream's traces as the fast loop solved them (`live-export.ts`)
or, on a factor run, Extract's on the stream's factors. A stream that found no
cells writes its run file with the result `skipped`. **Restart** connects again
as a new run.

## Reopening

Chrome and Edge keep the picked folder's handle (and a chosen project
folder's) in IndexedDB (`cala-projects`, `recent`); **Recent projects** on the
start screen reopens one with a click (the browser asks for permission again).
Other browsers pick the folder again; each run downloads as
`calab-project_<run id>.zip`, the run's folder with the project file and the
index as they were when it ended, to unpack into the animal folder; the next
open reads it.

Until the project file is written to the folder (no permission yet, or no File
System Access API), its draft is kept in IndexedDB (`calab-drafts`, keyed by
the folder name and each stream with its first video's size and date). The
next open of the same folder uses the draft when the folder has no project
file, or when the draft is newer than the folder's file of the same project; a
warning says so. The draft is removed once the file is written to the folder.

A run that goes into a zip keeps its `calab-run.json` in OPFS
(`calab-saved-runs/`) until it ends. If the tab closes or crashes first, the
next open of the project offers **Download run file**, and a step left
`running` is marked `stopped` so it can start again.

## Session boundaries in Joint runs

A Joint chain runs its sessions as one recording. At each boundary cala
re-registers the new session to the previous one (rotation and a wide
translation), re-seats the flicker reference, and carries the background floor
and noise map into the new session's brightness. See
[stages.md](stages.md#boundaries). Separate runs start each session fresh and
need none of this.

Each boundary also gets a health flag (ok, warning or failed, with the reason;
[stages.md](stages.md#boundary-flags)). It is stored with the session's result in
the run file (`results[].boundary`, the export's JSON form) and so in the index
(`runs[].streams[].boundary`),
and the session table shows it as a badge on the row of the session that
starts at that boundary, with the reason as its tooltip. A failed boundary's
badge offers **Re-plan as Separate**: the chain's sessions go into the run plan
as Separate runs (only the plan changes; nothing starts). View results shows
the flag of the result's session.

## Not yet (later PRs)

- A Joint run takes no stream `overrides`.
- The plan view has no editor for a step's `params` (hand-edit the file).
- Safari before `createWritable` in OPFS keeps no copy of the run file (the draft
  project file is kept).
- "When defaults have moved": a loaded run file is not compared against today's
  defaults.
- A live stream's results folder cannot be picked before it starts: its run is
  always a zip.
- Saved library files, **Apply**, extending a Joint run from its library, the
  **Library** column.
- Cross-session cell matching (`identity/`).
- Opening a single `.npz` export outside a project.
