# Cala user guide (beta)

Cala turns raw 1-photon Miniscope video into cell footprints and traces, in your
browser. Open it at [miniscope.github.io/CaLab/Cala](https://miniscope.github.io/CaLab/Cala/).
It is a **beta**: the pipeline works end to end, and the limits are listed at the
bottom. Developer notes are in [README.md](README.md).

## What it does

- Reads a Miniscope AVI folder from disk, a batch of frames at a time. Videos are
  never uploaded and never loaded whole.
- Preprocesses the frames (hot pixels, global flicker, glow, line noise, background
  and noise estimates) and corrects rigid motion.
- Estimates the sensor's pixel-gain pattern (the flat field) from the recording's own
  motion and divides it out.
- Finds cells while the recording streams by, adds and prunes them as evidence
  accumulates, and extracts a trace for each.
- On a recording, lets the footprints keep converging over replays of the recording
  (**Refine**) and solves every frame with the final cell set (**Extract**).
- Shows quality-control indicators while it runs, and exports the result as NumPy
  `.npz` files.

## What you need

A **Miniscope recording folder**: a numbered series of `.avi` files, plus the sidecars
`metaData.json` and `timeStamps.csv` if you have them.

- Video names are `<prefix><number>.avi`: `0.avi, 1.avi, ...` (Miniscope V4 software),
  `msCam0.avi, msCam1.avi, ...` (older DAQ software), or another prefix of your own
  (letters, `_`, `-` or spaces). Zero-padded numbers (`msCam001.avi`) work, and files
  are sorted by number, not alphabetically. Gaps, repeated numbers and a series that
  does not start at 0 give a warning and still open.
- If the folder (or its subfolders) holds several series, such as `msCam*.avi` next to
  a `behavCam*.avi` behaviour camera, Cala picks the Miniscope one: it skips `behav*`
  prefixes and prefers `msCam` and unprefixed names. When it still cannot tell, it lists
  the series (name, file count, folder) and you pick one.
- `metaData.json` and `timeStamps.csv` are read from the folder of the chosen series.

- The frame rate comes from `timeStamps.csv`, else from `metaData.json`. The frame
  rate in the AVI header is ignored (real 20 fps files declare 60). The Recording tab
  shows which source was used.
- With neither sidecar, the recording still opens and plays back at an assumed 20 fps,
  but time-based settings and the exported sampling rate then rest on that assumption.
  Keep the metadata with your recordings.
- Files with a prefix (`neural_metaData.json`, `neural_timestamp.csv`) are recognised.
- Open the folder with the picker, or drop it on the page. **Choose individual files**
  is there for odd layouts: those files open in natural order (`clip 2` before `clip 10`)
  even when their names are not numbered like a series. Files are read locally and never leave your computer. In
  Chrome and Edge the picker asks permission to "view files" in the folder (read-only).
  Firefox and Safari show their own upload-worded confirmation, which is misleading:
  nothing is uploaded.
- The start page also has an optional live-source field (a WebSocket address, see the
  README). Leave it empty to work from files.

## Browser requirements

| Browser                | Status                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome, Edge (desktop) | Recommended. WebGPU motion correction when a GPU is available, and a save dialog that writes exports straight to a file you choose.                                             |
| Firefox, Safari        | Run the full pipeline with motion correction on the CPU (Safari itself has not been tested). Exports are built in the browser's private file system and handed to the download. |
| Any browser, no WebGPU | Motion correction falls back to the CPU. The badge in the Run panel says **Motion: CPU** or **Motion: WebGPU**. Throughput is lower; the method is the same.                    |

Needed in any browser: WebAssembly, module Web Workers, and a folder picker
(`showDirectoryPicker` in Chrome and Edge, else `<input webkitdirectory>`). Several CPU cores help: cell discovery uses the spare
ones. If the browser has no origin private file system (OPFS), Extract holds its traces
in memory, up to 1.5 GB, and says so with an error when a recording does not fit.
Use a desktop browser; a laptop with enough free RAM for the cell library and a
few batches of frames is plenty.

## The screen

The field of view fills the left of the window, as tall as the window allows. The
right-hand column holds three panels: **Run**, **Cell** and **Details**. Each one
collapses with the chevron by its title. Below about 1000 px of width, or in a
portrait window, the column moves under the image and the page scrolls.

**Field of view.**

- **View** (toolbar): **Raw**, **Preprocessed** (hot pixels, flicker, glow and lines
  removed), **Motion-corrected**, **Bg removed** (motion-corrected with the background
  floor removed, the default) and **Residual**. The residual is the background-removed
  frame minus every footprint times its trace: light that no cell explains yet. It is
  computed only while you look at it, from the next batch of a running pass once the
  model has cells.
- **Display range**: each view has its own fixed range. It is fitted once from the
  first frames and then held: changes in brightness stay visible. Type a range, or
  press **Re-fit range** to fit once more from the most recent frames.
- **Overlay** (card on the image): **Off**, **Contours** (the outline at 35% of each
  cell's peak, the default), **Footprints** (each footprint over its full extent,
  opacity = value over its own peak, no threshold) or **Both**. **Colour by** picks
  the colouring (when found, slow-loop status, QC pass/fail, peak SNR, trace fidelity,
  crosstalk, footprint error). The legend shows the scale, which is fixed per mode.
  **Residual heat map** lays the per-block residual (noise units, log scale) over the
  image. The **-** button folds the card away.
- **Zoom and pan**: scroll to zoom around the pointer, or use **-**, **+**, **Fit** and
  **1:1** (one recording pixel per screen pixel). Drag to pan. While zoomed, a minimap
  in the top right shows where you are; click it to jump. Click a cell to select it.

**Run panel.** One status line (percent read, frame, frames per second) and the
convergence status, with icon buttons to pause (⏸), restart (↻) and end Discover or
stop the live run (■). Below it: the time-window control (**Run** and, when the run is
long enough, **24 h**, **1 h**, **10 min**, **1 min**), the whole-run strip, and one
overlaid plot of the convergence metrics (cells, new cells per minute, churn, stable,
explained, residual). Collapsing the panel folds the plot away. Below the plot:
**Discover cells**, **Extract after Discover**, the **Refine** button and its readout,
Extract progress, **Extract** and the **Export** menu. In a narrow window the stages
show as a stepper (Calibrate, Discover, Refine, Extract, Export) and the metrics as
small tiles on the same fixed ranges. A live stream shows Discover only.

**Cell panel.** The selected cell's footprint over its full extent (its own peak = 1,
no threshold), on a **linear** or **log** scale (the log scale spans the 2.4 decades
the stored 8-bit footprint holds). The white line is its support and the grey lines
are its neighbours' outlines. The slider steps through the footprint's versions. Next
to it are the QC verdict and numbers. The **Trace** tab shows the whole session as an
overview with a live detail window; **Demixing** shows the overlapping neighbours. The
arrows step through the cells by id.

**Details panel.** Tabs: **Cell QC** (the cell table: click a row to select the cell),
**History** (see below), **Flat field**, **Timing** (per-stage times and the slow
loop's counters), **Raw file** (scrub the recording as read from disk) and
**Recording**.

## The History view: how the run evolves

Every quantity the run tracks is kept over the whole run, from a 5-minute file to a
5-day live stream, and drawn on one time axis (elapsed stream time: `m:ss`, then
`h:mm`, then days `d0`…`d5`).

- **Groups.** The Run panel shows **Convergence**. The **History** tab shows one group
  at a time: **Scales** (cell diameter, PSF and flatten σ, once the scale estimator
  lands), **Imaging** (noise σ and background, both the median over the field of
  view; flicker gain and offset; flat-field updates as stems), **Motion** (dy, dx,
  share of frames flagged, registration quality) and **Throughput** (processing rate,
  slow-loop lag, and for a live stream frames dropped per minute and live lag). The
  Cell panel folds to one line while History is open.
- **One plot per group.** Every series is drawn against its own fixed range, so they
  share one plot. The chips above it are the legend and the readout: click a chip (or
  a line, or use the arrow keys) to select a series. The selected one is drawn in
  full with its min/max envelope, and the y axis shows its units and range; the
  others are dimmed. Hover a chip for its full name, range and unit.
- **Hover** shows every series' value at that time, with the clock time. **Click**
  pins the time: the chips show the values then, in violet, and the Run panel shows
  a violet pill; **Esc** or the pill returns to now.
- **Zoom.** Drag on the whole-run strip, or drag or scroll inside a plot, to choose a
  window; double-click returns to the whole run. The window and the pinned time are
  shared by every plot.
- **Fixed ranges.** Ranges come from physics and biology, never from the data, and
  they never shrink. When a value goes past one, it steps up once along 1, 2, 5 x 10ⁿ
  (or doubles): the old limit stays as an amber dashed line, a ⇡ marks the step, the
  event goes into the log, and the group tab gets an amber dot.
- **Events.** The lane above each plot marks flat-field maps, pauses, gaps and
  warnings, and range steps; the **?** button explains the icons.
- **Expand.** The ⤢ button swaps History into the large area, with every group at once;
  the field of view moves into the History tab and stays live. ⤡ restores it.
- **Old periods are coarser.** The newest hour is kept at 1 s resolution, older
  periods at 4 s, 16 s, 64 s and 256 s bins; each bin keeps its minimum and maximum,
  so a spike is never lost. About 9 MB covers 5 days. The per-frame motion and
  flicker are in the export at full resolution regardless.

## How a run works

A run has three named stages: **Discover**, **Refine** and **Extract** (see
[docs/stages.md](docs/stages.md)).

1. **Opening starts Discover.** The recording is walked in batches. Preprocessing and
   motion correction run in workers, so the page stays responsive. The field of view
   shows the frame being processed at the stage you pick, with the cells over it.
2. **Discover finds cells.** A slow loop looks for new cells and prunes bad ones
   while the fast loop extracts traces with the library as it stands. The traces
   emitted early were solved with the cells known at that moment. **End Discover**
   (■) ends it at the frames read so far.
3. **Refine (optional, repeatable).** **Refine** replays the recording from frame 0,
   and the footprints keep converging. No cell is added, merged, split or deleted.
   Each run reports how many footprints it refined, the median footprint change and
   the refines per minute against the run before. "Looks settled" appears when the
   refine rate stops falling. A Refine after an Extract discards the Extract result,
   because its traces no longer match the footprints.
4. **Extract extracts traces.** It replays the recording with the final library, using
   the motion and flicker recorded during Discover, so a cell found late has a trace from
   frame 0. Run it with **Extract** once the footprints have settled. It starts by itself when Discover ends only if you turn on **Extract after Discover** (off by default, so a Refine does not discard an Extract; never after a Refine run).
5. **Export.** Once Extract has finished, the **Export** menu has **Export (.npz)**, which writes the main file: traces (cells x frames), cell
   ids and centroids, sparse footprints, per-frame motion and flicker, per-cell QC,
   and a JSON block with the run's provenance and the stages that ran. It holds two
   trace matrices: `traces`, which never goes below 0 (a quiet cell sits at exactly 0),
   and `traces_signed`, the same traces without that clip, so a quiet cell's noise
   is centred on 0 and can go negative. **Export for CaDecon (N cells)** writes just
   the signed traces of the cells that pass QC (untick **QC-passing cells only** to include
   every cell), for CaDecon, which needs the zero baseline. Python:
   `np.load("<folder>_cala.npz")["traces"]` (or `["traces_signed"]`). A live run has no
   Extract and no signed traces. The `.npz` also holds the run's history
   (`history_L0` … `history_L4`) and event log (`run_events_json`); see
   [Reading the run history in Python](#reading-the-run-history-in-python).

## An animal's sessions: projects

Most experiments are many sessions from one animal. **Open animal project** on the
start screen opens the animal's folder (for a Miniscope V4 tree, the folder that holds
`date/time/My_V4_Miniscope/`) as a project: one table of all its sessions, what cala
has done with each, and every result kept in `<animal>/cala-results/`.

- **If the folder holds several animals** (an experiment folder with one subfolder per
  animal, each with several sessions), the app offers to open one animal at a time.
  Pick the animal, or open everything as one project.
- **The session table** lists each session: its folder, date and time (from
  `metaData.json`), length, then whether **Discover**, **Refine** (how many times) and
  **Extract** ran, the **Cell IDs** column, and the **current result**. Rows marked with
  the same letter in **Cell IDs** (and the same coloured edge) share cell ids: they come
  from one Joint run, so cell 7 is the same neuron in each. `own` means a session's ids
  are its own (a Separate run). **Results** on a row lists every result of that session
  with its run, date, cell count and file path.
- **Run plan.** Tick sessions, then **Chain selected** (one Joint run through them: one
  library, shared cell ids) or **Run selected separately** (each its own run). Repeat to
  build a plan, e.g. sessions 1 to 3 chained, 4 and 5 separately, 6 to 8 chained; set
  how many **Refine runs** come before Extract, and **Start plan**. Chrome and Edge ask
  once for permission to save into the animal folder. The groups run one after another;
  each session's results are written, and its current result updated, as soon as it is
  done. If a stage fails or is cancelled the plan stops, keeps what is written, and
  leaves the unfinished groups in the plan. **Back to project** in the header returns to
  the table.
- **Current result.** A session's newest result is its current one. Older results are
  kept; **Set current** in its results makes an older one current again.
- **Where results go.** Each run gets its own folder, `cala-results/runs/<date>_<time>/`,
  laid out like a multi-session run's results, and `cala-results/cala-project.json`
  indexes them. Raw data folders are only read. **Choose another folder...** saves the
  results elsewhere. If the index is lost or damaged it is rebuilt from the run folders
  (with a note), and results written by a multi-session run before projects existed are
  picked up the same way. A renamed session folder is recognised by its start time and
  frame count; a folder that is gone is marked missing.
- **Reopening.** Chrome and Edge list **Recent projects** on the start screen: one click
  (and a permission prompt) reopens one. Other browsers pick the folder again; there each
  run downloads a zip of its run folder, to unpack into the animal folder.

Saved libraries (applying one session's cells to another), matching cells across Separate
runs, and opening a saved result in the viewer come in later versions. Details:
[docs/projects.md](docs/projects.md).

## Several sessions of one animal

To track the same cells across days, run the sessions together instead of
renumbering files into one folder. An animal project (above) does the same from its
session table and keeps the results indexed; the steps below are the one-off route.

1. **Pick the parent folder** (for a Miniscope V4 tree, the animal's folder that holds
   `date/time/My_V4_Miniscope/`). Every recording folder in it, at any depth, becomes a
   session; behaviour cameras are left out. If the kind of recording is unclear, the
   app asks which one is the Miniscope. Or click **Multi-session run** on the start
   screen and **Add session** for each folder.
2. **Review the session list.** Each session shows its path, frames, frame rate,
   size and recording start (from `metaData.json`). The default order is the
   recording start, else the path. **Up**, **Down** and **Remove** change the list;
   **Add session** appends more folders. Sessions must have the same size and bit
   depth (an error); a different frame rate is a warning.
3. **Choose the library mode.** **Joint**: one library. Discover runs through all
   sessions in order, Refine replays them all, and Extract solves each session with
   the final library, so a cell has the same id in every session. **Separate**:
   each session is its own run, one after another. Pick how many **Refine runs**
   come before Extract (default 1).
4. **Results location.** By default the results go next to the data, in
   `<picked folder>/cala-results/`; **Choose...** picks another folder. Chrome and
   Edge ask once for permission to save there when you press **Start**. Other browsers
   download one `cala-results.zip` with the same layout when the run ends.
5. **Start.** The run is automatic. The panel above the cell shows the mode, the
   session being run and each session's state. Each session's results are written
   as soon as they are final: after its Extract (Separate), or for all sessions after
   the Extract (Joint).

The results mirror each session's path, so nothing is ever written into a data folder:

```
cala-results/
  cala-run.json                          the run: mode, settings, sessions, boundaries
  2026_11_10/14_02_33/My_V4_Miniscope/
    cala-export.npz                      the usual export, for this session's frames
    cala-session.json                    the session: index, path, stages run, cell ids
```

If `cala-results` already exists, a new `cala-results_<date>_<time>` folder is made
instead. In a Joint run the History plots and the cell trace mark where each session
starts. At the boundary the run goes straight on, as with concatenated files; how
cala should handle a boundary is still being measured.

## Reading the quality-control indicators

**Convergence status** (Run panel header, with the convergence plot below it). Cell discovery does not stop on long
recordings, so "converged" means the cells already found stopped changing, not that
no new cells appear.

- **Waiting for cells**: nothing to judge yet.
- **Discovering cells**: less than two minutes of history, or most cells are under a
  minute old.
- **Settling**: some cells' footprints or traces are still changing against 1 to 2
  minutes ago, or churn is high. The line says how many.
- **Converged**: at least 85% of cells are stable and churn is under 3.5% of the
  library per minute, over the last two minutes. The rate of new cells is shown but
  never blocks this. It says nothing about cells Cala cannot see.

**Cell QC tab.** One row per cell, failing cells first. A cell is **not measured
yet** until it has about a minute of trace history. The pass/fail rule is: peak SNR of
at least 5, and not the weaker of two overlapping cells whose traces correlate above
0.8. During Discover the peak SNR is read on each cell's last minute of trace (in
seconds, at the recording's frame rate). After Extract it is recomputed on the
extracted traces over the whole recording (or over each session, in that session's
export); before, the table kept the last minute of Discover. A clean cell that happens
to be quiet in its last minute no longer fails on a low SNR.

| Verdict or flag       | Meaning                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| passes                | Peak SNR at least 5 and no duplicate verdict.                                                                                                    |
| low SNR               | Peak SNR below 5: events barely rise above the noise. Fails.                                                                                     |
| possible duplicate of | Overlaps a stronger cell whose trace correlates above 0.8: a likely split or duplicate. Fails.                                                   |
| trace follows motion  | The trace tracks the frame's rigid shift (r squared above 0.2): sensor-gain shimmer or a motion artifact. Shown as a flag, does not fail a cell. |

Other columns (trace fidelity, expected crosstalk, shape descriptors) are colour
scales or descriptions, not pass marks.

## The flat field

Each sensor pixel has its own gain (about 5% SD). Registration moves the image over
the sensor, and traces that pick up this fixed pattern follow the motion. Cala
estimates the pattern from the recording's own motion:

- It needs about **150 s** of recording with motion before the first map. The
  frames before that are uncorrected, and the frame where the map switches on is
  recorded in the run (Flat field tab, export `meta_json`). Later refinements come about
  every 60 s and are small.
- The **Flat field** tab shows the map on a fixed 0.9 to 1.1 scale and its status.
  The flat field is on by default. To run without it, untick **Divide out the
  sensor gain map** (takes effect at the next Restart) or open the page with
  `?flatfield=0`.
- The map is cached in your browser (IndexedDB) so the next recording from the same
  sensor starts corrected. The cache key is a serial number from `metaData.json`
  when it has one. Stock Miniscope metadata has none, so the key is then the folder
  name, and a renamed folder starts from scratch. A map is never reused for a
  different frame size.
- Refine and Extract use Discover's newest map from frame 0.

## Testing with a simulated stream

To try the live source without an acquisition board, replay a recording as if
it were arriving live. From a CaLab checkout (Node 22.18 or newer):

```sh
npm run sim-stream -- /path/to/recording
```

The path can be a Miniscope AVI folder (replays real data as if live) or a
minisim recording (the sim directory, or its `daq/` folder). The command prints
a `ws://localhost:8765` address. Paste it into the start page's live-source
field and press Connect (or open the app with `?live=ws://localhost:8765`).

Useful options: `--fps 30` (default: the rate in the recording's metadata),
`--loop` (start over at the end, for as long as you like), `--start 2000`
(begin at that frame), `--frames 1000` (stop after that many) and `--port`
if 8765 is taken. Press Ctrl+C to stop the stream. The recording is only read,
never changed. See the README for the protocol and the full option list.

## Known limitations

- **Beta.** Expect rough edges, and check the results against your own data.
- **Footprints still changing.** At the end of a 20-minute pass about 1 footprint in 10
  may still be changing; the convergence status in the Run panel says where a run stands.
- **Somatic footprints only.** Cala looks for compact, single-peaked cell bodies, not
  dendrites or neuropil.
- **Gain stability over days is untested.** The cached flat field assumes the sensor's
  pixel gain does not change between sessions; this has not been checked across days.
- **Offline throughput.** Throughput depends on the machine and on whether WebGPU is
  available. On an Apple-silicon laptop, Chrome with WebGPU ran roughly 175 to 215
  frames/s on a 600 x 600 recording and CPU-only runs about 110 to 160. Refine and
  Extract repeat the walk, so a long recording takes a while.
- **Live acquisition is experimental.** The live-source field on the start page
  streams frames from a WebSocket (see the README). Apart from
  [testing with a simulated stream](#testing-with-a-simulated-stream), it is not
  covered by this guide.
- **Everything stays in the tab.** Closing the page discards a run that was not
  exported.

## Reading the run history in Python

The `.npz` export (format version 2 and later) holds the History view's bins and the run's
event log. `meta_json["history"]` describes the layout: for each level `k` its bin
width `bin_s` and first bin time `t0_s` (stream seconds, frame / sampling rate), and
for each series its `key`, `label`, `unit`, and initial and final display range.

```python
import json
import numpy as np

z = np.load("<folder>_cala.npz")
meta = json.loads(z["meta_json"].tobytes())
hist = meta["history"]
keys = [s["key"] for s in hist["series"]]

def series(key, level=None):
    """Bin start times (s) and (min, max, mean, last) of one series; NaN = empty bin."""
    levels = hist["levels"]
    lv = levels[-1] if level is None else next(l for l in levels if l["k"] == level)
    bins = z[f"history_L{lv['k']}"][keys.index(key)]  # [n, 4]
    t = lv["t0_s"] + lv["bin_s"] * np.arange(bins.shape[0])
    return t, bins

t, b = series("shift_dy")            # the coarsest level covers the whole run
peak = np.nanmax(b[:, 1])            # extrema survive every level
events = json.loads(z["run_events_json"].tobytes())
ranges = [e for e in events if e["kind"] == "range"]
```

The finest level (`history_L0`, 1 s bins) covers the newest 68 minutes; each coarser
level (4x wider bins) reaches further back, and the coarsest always covers the whole
run.
