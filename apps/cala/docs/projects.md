# Animal projects

Most Miniscope experiments are many sessions from one animal. Cala opens
the animal's folder as a **project**: one table of every session, with its
recording facts and cala status, runs over any mix of sessions, and every
result kept together in `cala-results/`.

Code: `src/lib/project-index.ts` (the index, pure), `src/lib/project-io.ts`
(reading and writing the results folder), `src/lib/project-store.ts` (the open
project and its run plan), `src/lib/run-plan.ts`, `src/lib/recent-projects.ts`,
`src/components/ProjectView.tsx`. Runs go through the multi-session runner
(`src/lib/multi-run.ts`, [stages.md](stages.md), "Sessions").

## The project root is the animal folder

**Open animal project** on the start screen picks the animal's folder. The
sessions are found as for a multi-session run (`discoverKinds` and
`chooseKind`: every numbered video series at any depth, the Miniscope kind
chosen, behaviour cameras left out). A session's id is its folder relative to
the animal folder, e.g. `2026_11_10/14_02_33/My_V4_Miniscope`.

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
one project. A folder that already holds `cala-results/cala-project.json` is
never offered a split. With the File System Access API the other animals are
added to Recent projects.

## Results location

Results go to `<animal>/cala-results/` by default. **Choose another folder...**
on the project view writes them to a folder the user picks instead; that folder
then plays the role of `cala-results` (the index lives in it), the index records
it (`project.results_location`), and Recent projects keeps its handle. A raw
data folder is only ever read: nothing is written outside the results folder.

Each run of the project view writes to its own folder,
`cala-results/runs/<run id>/`, laid out as a multi-session run's results
(`cala-run.json` at its root, then each session's path holding `cala-export.npz`
and `cala-session.json`). A run folder is never reused (a suffix is added).

```
mouse1/                                     the animal (only read)
  2026_11_10/14_02_33/My_V4_Miniscope/...
  cala-results/
    cala-project.json                       the project index
    runs/2026-11-13_14-02-33/               one run (a run plan's group)
      cala-run.json
      2026_11_10/14_02_33/My_V4_Miniscope/
        cala-export.npz
        cala-session.json
    cala-run.json, 2026_11_10/...           a run written before projects existed (#377), if any
```

## The index: `cala-results/cala-project.json`

The index is a cache of the run folders. It can always be made again from them
(`rebuildIndex`), so losing it loses only which result was set current by hand.

| Key              | What                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `format`         | `"cala-project"`                                                                               |
| `schema_version` | `1`                                                                                            |
| `project`        | `root_name`, `results_location` (`{kind: "default" \| "custom", label}`), `created`, `updated` |
| `sessions[]`     | one per session (below)                                                                        |
| `runs[]`         | append-only, one per run (below)                                                               |
| `results[]`      | one per session a run wrote (below)                                                            |
| `cell_matches`   | reserved for cross-session matching of Separate results; always `[]` in version 1              |

**Session:** `id` (path relative to the animal folder; `"."` for videos in the
root), `start` (`recordingStartTime`, ISO), `frames`, `fps`, `width`, `height`,
`bit_depth` (from the videos), `missing` (the folder is gone), `previous_ids`
(names it had before a rename was matched). Only what `metaData.json` and the
videos say; there are no hand-typed columns.

**Run:** `id` (its folder name, a local timestamp; `legacy-...` for a run found
at the results root), `folder` (relative to the results folder; `""` for a #377
tree at its root), `mode` (`joint` | `separate`), `sessions[]` (`id`, `status`
`pending | written | skipped | failed`, `note`, `stages`: the stage runs as
the export's `stages_run` records them, with times and outcomes, and for the
later sessions of a Joint run `boundary`: the health flag of the boundary the
session starts with), `settings`
(`refine_runs`), `app_version`, `created`, `updated`, `finished`, `stopped` (why
it stopped), `plan` (`{id, group, groups}` for a run plan's group), and
`library_in` / `library_out` (`null`; saved libraries come in PR 2).

**Result:** `session`, `run`, `export_path` (relative to the results folder),
`cells`, `cell_ids`, `id_space`, `library_version`, `created`, `current`.

### Cell identity

`id_space` says where a result's cell ids come from. Results with the same id
space share cell ids: cell 7 is the same neuron in each.

- A **Joint** run is one id space across its sessions: `run:<run id>`.
- A **Separate** run gives each session its own: `run:<run id>/<session id>`.
  Matching cells across Separate results (registration, footprint matching) is
  not built; `cell_matches` is where it will go.
- A saved library (PR 2) will be its own id space, `library:<id>`, shared by
  every session it is applied to.

The session table's **Cell IDs** column letters the id spaces that several
sessions' current results share (`A`, `B`, ...) and colours those rows'
edges; `own` marks a session with ids of its own.

### Example

```json
{
  "format": "cala-project",
  "schema_version": 1,
  "project": {
    "root_name": "mouse1",
    "results_location": { "kind": "default", "label": "mouse1/cala-results" },
    "created": "2026-11-13T14:01:50.000Z",
    "updated": "2026-11-13T14:20:12.000Z"
  },
  "sessions": [
    {
      "id": "2026_11_10/09_00_00/My_V4_Miniscope",
      "start": "2026-11-10T09:00:00.000Z",
      "frames": 1000,
      "fps": 20,
      "width": 600,
      "height": 600,
      "bit_depth": 8,
      "missing": false,
      "previous_ids": []
    }
  ],
  "runs": [
    {
      "id": "2026-11-13_14-02-33",
      "folder": "runs/2026-11-13_14-02-33",
      "mode": "joint",
      "sessions": [
        {
          "id": "2026_11_10/09_00_00/My_V4_Miniscope",
          "status": "written",
          "stages": [
            {
              "stage": "discover",
              "index": 1,
              "started_at": "2026-11-13T14:02:34.000Z",
              "ended_at": "2026-11-13T14:08:10.000Z",
              "outcome": "done",
              "frames": 2000,
              "cells": 41,
              "library_version": 57
            }
          ]
        }
      ],
      "settings": { "refine_runs": 1 },
      "app_version": "v2.14.0",
      "created": "2026-11-13T14:02:33.000Z",
      "updated": "2026-11-13T14:20:12.000Z",
      "finished": true,
      "plan": { "id": "2026-11-13_14-02-33", "group": 1, "groups": 2 },
      "library_in": null,
      "library_out": null
    }
  ],
  "results": [
    {
      "session": "2026_11_10/09_00_00/My_V4_Miniscope",
      "run": "2026-11-13_14-02-33",
      "export_path": "runs/2026-11-13_14-02-33/2026_11_10/09_00_00/My_V4_Miniscope/cala-export.npz",
      "cells": 41,
      "cell_ids": [1, 2, 4],
      "id_space": "run:2026-11-13_14-02-33",
      "library_version": 57,
      "created": "2026-11-13T14:20:12.000Z",
      "current": true
    }
  ],
  "cell_matches": []
}
```

### Rules

- **Current result.** When a run writes a session's result, that result
  becomes current if it is at least as new as the session's current one (so a
  new run's result is current, and an older run folder found later is not).
  Older results are kept; **Set current** in a row's results makes any of them
  current again.
- **Updated as sessions finish.** The project view hands the runner an
  `onProgress` callback (`MultiRunPlan.onProgress`); the index is written each
  time a session's results are (Separate: after each session; Joint: after the
  final Extract), when a session is skipped, when a run ends and when it stops.
- **Written whole, then swapped in.** The File System Access API has no
  rename, but a writable stream writes to a swap file that replaces the file
  only on `close()`, so a reader sees the old index or the new one, never half.
- **Validated on read.** A missing or unreadable index is rebuilt from the run
  folders, with a warning; the unreadable file is kept as
  `cala-project.corrupt-<time>.json` at the next write. An index with a newer
  `schema_version` is shown (rebuilt in memory) but never overwritten.
- **Rebuildable.** `rebuildIndex` finds every `cala-run.json` under the results
  folder and gives each `cala-session.json` to the nearest run manifest above
  it; this covers `runs/<id>/` and a #377 tree at the results root. A run
  manifest's session path (which starts with the folder that run was picked at)
  maps to a project session by id, else by an id it ends with (picked one level
  up), else by start time and frame count. On every open, run folders the index
  does not hold are merged in the same way.
- **Renamed folders.** A session in the index whose folder is gone is matched
  to a new folder with the same `recordingStartTime` and frame count (exactly
  one candidate); its results follow it and the old id goes to `previous_ids`.
  Unmatched, it stays in the table flagged missing.
- **When it is written.** Opening a project asks only to read. The index is
  written at the first change (a run, Set current), when Chrome asks for
  permission to save; a reopened project that already has that permission
  saves a refreshed index straight away.

## The session table

Columns: the session, its date (`recordingStartTime`), its length (frames and
duration), then **Discover**, **Refine** (the count of finished Refine runs)
and **Extract**, from the current result's run (else the latest run with that
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
log, the stages that ran, and the flat field. There are no Discover, Refine or
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

Selected rows go into a **run plan** as groups:

- **Chain selected**: one Joint run through those sessions in start-time order
  (one library, cell ids shared).
- **Run selected separately**: a Separate run of each (a library per session).

A session is in one group at most (adding it again moves it), and a chain of
one session is a Separate run. Groups can be reordered and removed. **Start
plan** asks for permission to write, then runs the groups one after another;
each group is one run in the index (`plan` records the plan and group), and
each session's current result updates as its results are written. If a stage
fails or is cancelled the plan stops: results already written stay, and the
groups not finished stay in the plan to start again. **Back to project** in the
viewer's header returns to the table (stopping a running plan).

## Reopening

Chrome and Edge keep the animal folder's handle (and a chosen results
folder's) in IndexedDB (`cala-projects`, `recent`); **Recent projects** on the
start screen reopens one with a click (the browser asks for permission again).
Other browsers pick the folder again; their runs download a zip of the run's
folder (`cala-results/runs/<id>/...`) to unpack into the animal folder, and the
next open merges it into the index. Changes to the index (Set current) are not
saved there.

## Session boundaries in Joint runs

A Joint chain runs its sessions as one recording. At each boundary cala
re-registers the new session to the previous one (rotation and a wide
translation), re-seats the flicker reference, and carries the background floor
and noise map into the new session's brightness. See
[stages.md](stages.md#boundaries). Separate runs start each session fresh and
need none of this.

Each boundary also gets a health flag (ok, warning or failed, with the reason;
[stages.md](stages.md#boundary-flags)). It is stored with the session's run
entry in the index (`runs[].sessions[].boundary`, the export's JSON form; read
back from `cala-session.json` or `cala-run.json` when the index is rebuilt),
and the session table shows it as a badge on the row of the session that
starts at that boundary, with the reason as its tooltip. A failed boundary's
badge offers **Re-plan as Separate**: the chain's sessions go into the run plan
as Separate runs (only the plan changes; nothing starts). View results shows
the flag of the result's session.

## Not yet (later PRs)

- Saved library files, **Apply** (a library to other sessions), extending a
  Joint run from its library: `library_in` / `library_out` on runs, the
  **Library** column, and the `library:<id>` id space are the places.
- Cross-session matching for Separate results: `cell_matches`.
- Pixel size and a scale bar.
- Opening a single `.npz` export outside a project.
