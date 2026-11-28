# Cala user guide (beta)

Cala turns raw 1-photon Miniscope video into cell footprints and traces, in your
browser. Open it at [calab.miniscope.org/Cala](https://calab.miniscope.org/Cala/).
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
- On a recording, lets the footprints converge with look-back and a Final settle during
  Discover, then solves every frame with the final cell set (**Extract**).
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
- If the folder (or its subfolders) holds several series, such as the Miniscope's
  `img/` next to a behaviour camera's `behav/`, Cala picks the Miniscope from the
  metadata the Miniscope software writes: the recording's `metaData.json` lists
  `"miniscopes"` and `"cameras"`, and each device's own `metaData.json` gives its
  `deviceType`. Without metadata it goes by name: it skips `behav*` folders and
  prefixes and prefers `msCam` and unprefixed names. When it still cannot tell, it
  lists the series (name, file count, folder, and "behaviour camera" where it
  thinks so) and you pick one.
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
  even when their names are not numbered like a series. Files are read locally and never leave your computer
  (unless you choose to share a recording, see [Sharing a recording](#sharing-a-recording)). In
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
| Any browser, no WebGPU | Motion correction falls back to the CPU. The chip in the Run tab's Compute block says **CPU motion** or **GPU motion**. Throughput is lower; the method is the same.            |

Needed in any browser: WebAssembly, module Web Workers, and a folder picker
(`showDirectoryPicker` in Chrome and Edge, else `<input webkitdirectory>`). Several CPU cores help: cell discovery uses the spare
ones. If the browser has no origin private file system (OPFS), Extract holds its traces
in memory, up to 1.5 GB, and says so with an error when a recording does not fit.
Use a desktop browser; a laptop with enough free RAM for the cell library and a
few batches of frames is plenty.

## The screen

The field of view fills the left of the window, as tall as the window allows. The
right-hand column has the **run rail** at the top, always in view, and below it one
row of tabs: **Run**, **Cell**, **QC** and **History**, then **More ▾**, a menu of the
diagnostics: **Correlation**, **Flat field**, **Timing**, **Raw file** and **Recording**.
While one of those is shown, the More tab carries its name. One tab shows at a time, with
the column's whole height. Selecting a cell (in the field of view, the QC table or a
neighbour link) opens the **Cell** tab. The arrow keys move between the tabs (Home and End
to the first and last); on **More**, Down, Enter or Space opens its menu, Up and Down move
in it and Escape closes it. The app remembers the tab you were on. A 1024 px window keeps
the image and the column side by side (the column is at least 440 px wide). Narrower, or in
a portrait window, the page stacks the run rail, the image and the tabs, in that order, and
scrolls up and down (never sideways), so the run's state is at the top. On a phone-wide
window the rail's four figures sit in two rows of two.

**Theme.** The three small buttons at the top right of every screen choose the colour
theme: follow the system (the default), light or dark. The choice is remembered in this
browser. The theme changes only the page around the image: the field of view keeps its
fixed display range and its overlay colours in both themes.

**Run rail.** Above the tabs, one place for every live figure of the run:

- **Stage track**: one bar in three segments, **Discover**, **Final settle** and
  **Extract**, each sized by how long it is expected to take and filling with its own
  progress in its own colour (Discover blue, Final settle plum, Extract orange). A waiting
  stage shows its pale tint, the running one has an edge in its colour, a finished one is
  filled with its colour and has a ✓ (green is kept for QC pass and other status), a stage
  that will not run (look-back off, Extract unticked, a live stream) is hatched grey, and
  one stopped by an error has a red outline and ✕. The hatched start of Discover is the
  setup (**Calibrating**, **Motion template**). Hover a segment for its exact frames and
  percent. In a run of several sessions a thin ribbon above it shows each session (done ✓,
  running, waiting) and "Session 2/3".
- **The line under it**: where the current stage is (frame 824 / 1,000, Final settle
  300 / 1,000, Extract frame 400 / 1,000) and the whole run's time left, estimated from
  the current stage's speed. Beside it, the stage's controls: pause and end for Discover
  (stop for a live stream), stop for the Final settle, cancel for Extract.
- **Cells**: the cell count of the live library, with a sparkline of it along the run
  (the same left-to-right as the stage track). Its range starts at 0 and ends at the
  number printed beside it (10, 20, 50, 100, ...): it rounds up and never shrinks during a
  run. The dot is the convergence state (blue while cells are still changing, a green ✓
  once converged, grey once Discover has ended without converging); hover for the reason,
  the library version and its lag.
- **Speed**: the speed achieved now, on a fixed log scale from 10 to 500 fps. The black
  tick is the target (none at Max), the grey tick the floor (the slowest speed that still
  gains anything).
- **Workers busy**: how many workers' worth of time was in use over the last second, of N,
  the most workers counted so far in this run. N never drops during a run; it grows once
  when the Final settle starts its pool of look-back workers.
- **Refinement**: Discover's refinement visits per frame, on a fixed 0 to 0.5 scale, with
  the target tick and its allowed band (2/3 to 4/3 of the target) shaded. It turns amber
  with ⚠ while the run is held slower than your Speed setting to keep refinement up.
- **Memory**: the WebAssembly memory of the page and its workers together, on a fixed
  0 to 4 GB scale. It is not the tab's whole footprint (JavaScript heaps in the workers,
  transferred buffers and GPU memory are invisible to the page) and it never shrinks
  during a run; hover the ⓘ for these limits.

The figures update at most twice a second; a grey dash means not measured. A live stream gets the Final settle and Extract after it
ends, on the factors it wrote. A recording's frames are compressed on the GPU while Discover runs (the GPU
route, by default; `?factors=gpu` asks for the same), and its Final settle and Extract read those factors
when they are complete; when not they say "re-reads the file" with the reason. Without WebGPU or with too
little GPU memory the run reads the file and says why. When the GPU falls behind, Discover waits for it (at
most 30 s without progress, then the run reads the file). A GPU that makes Discover wait more than 10 % of its
time (judged after each window, from the third on, while the recording runs) gives its factors up, and the Run
panel and the export say "the GPU compressor made Discover wait N % of its time; the file is read instead". The
export's `compress_wait_s` says how long Discover waited. `?factors=0` turns factors off for streams and
recordings: Discover only for a stream, and a recording's settle and Extract read the file, as before.
`?factors=file` (experimental) compresses a recording's factors on the CPU instead. Look-back and Background settle run
inside Discover.

**Field of view.**

- **View** (toolbar): **Raw**, **Preprocessed** (hot pixels, flicker, glow and lines
  removed), **Motion-corrected**, **Bg removed** (motion-corrected with the background
  floor removed, the default) and **Residual**. The residual is the background-removed
  frame minus every footprint times its trace: light that no cell explains yet. It is
  computed only while you look at it, from the next batch of a running pass once the
  model has cells.
- **Display range** (toolbar, right): each view has its own fixed range, drawn as a
  grey colour bar between its two end values. It is fitted once from the first frames
  and then held: changes in brightness stay visible. Type an end value to change it,
  or press the re-fit icon (four corners) to fit once more from the most recent
  frames. Nothing else changes it.
- **Overlay legend** (a chip in the image's top left: the colour mode's marks and
  name). Click it to open the card: **Off**, **Contours** (the outline at 35% of each
  cell's peak, the default), **Footprints** (each footprint over its full extent,
  opacity = value over its own peak, no threshold) or **Both**. **Colour by** picks
  the colouring (when found, slow-loop status, QC pass/fail, peak SNR, trace fidelity,
  crosstalk, footprint error). The legend shows the scale, which is fixed per mode.
  **Residual heat map** lays the per-block residual (noise units, log scale) over the
  image. Click the chip again to fold the card. On a narrow image (a phone-wide
  window) the card starts folded so it does not cover the cells.
- **Zoom and pan**: scroll to zoom around the pointer, or use **-**, **+**, **Fit** and
  **1:1** (one recording pixel per screen pixel). Drag to pan. While zoomed, a minimap
  in the top right shows where you are; click it to jump. Click a cell to select it.

**Run tab.** Opening a recording does not start the run. The Run tab first shows the
**pre-run sheet**: the settings read when Discover starts, then **Speed**, and the **Run**
button at the top of the sheet. Discover starts only when you press **Run** (the image
stays empty until then; the **Raw file** tab already plays the recording). The settings
are grouped:

- **Cell size**: **Expected cell diameter** in µm at the sample, the largest cells you
  expect. Under it the sheet shows the diameter in pixels it gives ("= 16 px at 2.00 µm per
  pixel"). Left empty, the run uses 10 px.
- **Microscope**: **Sensor pixel size** (µm), **Magnification**, **Binning** and **Sensor
  width** (px). One frame pixel is sensor pixel size × binning ÷ magnification at the
  sample; with the sensor width and no binning given, the binning is the sensor width over
  the frame width. The µm diameter needs at least the sensor pixel size and the
  magnification; until they are set, Run stays off and the field says why.
- **Look-back**, **Final settle** (Thorough, Standard, Quick), and under **Stages**,
  **Find new cells** (on by default; off, Discover keeps tracking the cells it has but finds
  no new ones; this one applies at once, also during a run) and **Extract after Discover**.
- **Advanced** (folded): the diameter in pixels set directly (it then overrides the µm
  diameter, and the run record says so), motion correction (largest shift, the template
  time constant), preprocessing, the cell finder's thresholds and memory, the look-back
  horizon and the QC pass rule. Each field's **?** explains it and gives its range; a value
  outside the range is refused with a message under the field.

A setting that is not its default shows where it came from (**set** here, **file**, or
**project**, **step** or **stream** for a value the project gives: see below) and a ↺ to
return it to its default. Settings set elsewhere in the app (Speed, the Background settle
cap, the flat field, the QC pass/fail export filter) are not repeated in the sheet.

**Config files.** **Save config…** writes the values you set (not the defaults) and where
each came from to `cala-config.json`; **Load config…** reads one back, for another
recording or another animal. A config file is JSON, may carry `//` comments, and may list
only some settings: the rest keep their defaults. Load refuses a file with a value outside
a setting's range and names it; a key that is not a setting is listed (with the setting it
probably meant) and kept in the file, but not used. **Clear** returns every setting to its
default. An example is in `apps/cala/docs/example-config.json`; every setting, its unit and
its range are in `crates/cala/schema/cala-params.schema.json`. The export's run record
holds what was asked for, where each value came from, and the cell diameter in pixels the
run used.

**Load config…** also takes a run's `calab-run.json` or a past export (`.npz`): it loads
what that run **asked for**, not what its data set, so the new run measures the frame
rate (and, later, the cell size) from its own data. **Also pin what the data set** loads
the measured values too, as settings (an exact repeat). **Config (.json)** in the Export
menu saves a run's settings as a config file.

**Project defaults.** **Save as project defaults** moves the values you set (and a loaded
file's) into the project: every run of the project starts from them, in this and later
visits. Tick **This session only** first to save them for this session alone (**Save for
this session**). A run's settings are, from lowest to highest: the defaults, the project's
defaults, the plan step's settings, the session's own, a loaded config file, then what you
set in the sheet. They are kept in `calab-project.json` (`defaults`, each stream's
`overrides`, each step's `params`; it can be edited by hand) and the run file names the
layer each value came from.

A live stream has no sheet: connecting starts it. A project's run plan starts from its
**Start plan** button and has no sheet either.

Once the run has started, the header has icon buttons to pause, restart (↻) and end
Discover or stop the live run, and the tab shows, in the order you use them:

- **Settings**: one line of chips with the settings the run started with (for example
  "Look-back on · Final settle Thorough · Extract after Discover"), and one chip per further
  value the run asked for ("Expected cell diameter 32 µm"). Click it to open the same fields
  and the config buttons. Changes **apply on Restart** (↻); in a Separate run of several
  sessions they apply from the next session.
- **Progress**: one row per step, **Discover**, **Final settle** and **Extract**. The
  running step is a panel with its header (name, state, percent, frames per second, time
  left), its bar and its meter rows, each on a fixed range:
  - Discover (with look-back): **Cells waiting for data** (of the cells found),
    **Look-back re-read** (frames) and **Background settle** (saved frames re-read per live
    frame, 0 to 2, the tick at the ceiling in force).
  - Final settle: **Frames re-read** (of its plan), **Cells still moving** (the tick marks where the
    footprints count as settled), **Footprints settled** and **Visits per frame** (0 to 1),
    with a note when it reads the factors or re-reads the file (and why), and **Stop Final
    settle**.
  - Extract: its frames-per-second trace, **Frames solved**, **Speed** (10 to 500 fps,
    log) and the number of cells it solves.

  Every other step is one line: a finished step is its stage colour with ✓ and its result
  and time ("✓ Discover · 383 cells · 0:48"), a waiting one says waiting, one that will
  not run says off and why. While Discover runs, its panel also has **Lag behind reading**:
  how many frames the cell model is behind the frames read (fixed 0 to 60 s of recording).
  Above the steps the status line (Discover done).

- **Over the recording** (**Over the stream** for a live run): one strip with three rows on
  the same time axis, so a moment lines up in all of them, and one set of time labels under
  the last row (stream time, m:ss). The **Plot window** control (**Whole run** and, when the
  run is long enough, **24 h**, **1 h**, **10 min**, **1 min**) and the whole-run strip
  above it set the window for all three rows; click the convergence plot to inspect a time (the other rows mark it), drag on it or on the whole-run strip to brush
  one.
  - The convergence plot: the overlaid metrics (cells at frame, new cells per minute,
    churn, stable, explained, residual). **Cells at frame** is the count at each QC
    snapshot (once per second of recording); it stops at the end of Discover, so
    afterwards the rail's **Cells** is the current count.
  - **fps** on a fixed 10 to 500 log scale: the target dashed (Max at the top), the speed
    achieved solid, the floor dotted, and in Curve mode the plan in long dashes; a thin
    line marks each change of target.
  - **Workers busy, by kind**, 0 to the number of workers: each reading (about once a
    second) covers the time since the reading before it, so the bands are steps; the
    interval since the last reading is drawn up to the playhead and settles when its
    reading comes in. The colours are the worker squares' (below).

  A recording with look-back adds a **Final settle** column on the right, on its own axis
  (the frames it re-read, 0 to its plan), because no recording time passes then: its
  frames per second (fixed 10 to 500, log) and its work by kind. The strip redraws at most twice a second.

- **Compute**: where the run's machine time goes. The header shows where motion
  correction runs (**GPU motion** or **CPU motion**; amber with a warning icon if WebGPU
  failed mid-run) and how many workers are busy. Under it **Speed** (see below) and
  **Workers**: one 28 px square per worker (a browser thread), grouped as Frame loop,
  Cell model, Footprint helpers and Look-back and settle. Each square fills from the
  bottom with one colour per job (**Read frames** light blue and **Find cells** blue, the
  Discover colour; **Look-back** teal; **Background settle** plum stripes and **Final
  settle** plum, the Final settle colour; grey is **Idle**), each as tall as that job's
  share of the last second; the figure under the square is how busy the worker was, in
  percent. The **?** beside Workers explains the squares; hover a square for the split.
  Read frames, Find cells, Look-back and Background settle are the jobs of Discover; while
  the Final settle runs, all the work shown is Final settle. Extract runs after it and is
  not in the grid.
- **Speed** (in Compute, and in the pre-run sheet): **Max**, **Fixed**, **Curve** or
  **Auto**. Max and Fixed show the track, fixed 10 to 500 fps on a log scale: the hatched
  start is where going slower gains nothing, the **floor** tick is the slowest useful
  speed, the **max** tick what this machine reaches now (a target above it behaves as
  Max), and a light fill shows the speed achieved. The labels over the track never
  overlap: when they would, the max label wins. Drag the thumb, or use the arrow keys, to
  set a Fixed target; at Max the thumb sits on the **Max** stop. **Curve** shows its plan
  instead of the track: the target over the recording (0 to 100 %, same fps scale, the
  floor dotted, a line where Discover is now). **Auto** shows its time budget: before the
  run, a bar of a Max run's time plus the extra time you allow; during the run, **Budget
  used** in seconds of the budget (paused time does not count). While Discover runs the
  **Refinement** gauge shows the visits per frame (see Discover, below).

- **Results**: **Extract** (or **Extract again**) and Extract's status line.

**Export** is on the run rail: once there is a result (Extract done, or a live run ended)
the rail shows the **Export** button, with "Includes the run record" beside it. Its menu has
**Export (.npz)** and **Export for CaDecon**.

A live stream with `?factors=0` shows Discover only. Every run then shows the
**Sessions** block, with where its results go; in a run of several sessions it holds the mode, the run's status, a meter of
the results written (and, for a project's plan, of its groups), and one row per session
with its state (written ✓, running, pending, skipped, failed) and, in a Joint run, each
boundary's health badge.

**Cell tab.** From top to bottom:

- The selected cell's **footprint** over its full extent (its own peak = 1, no
  threshold), on a **linear** or **log** scale (the log scale spans the 2.4 decades the
  stored 8-bit footprint holds). The white line is its support and the grey lines are
  its neighbours' outlines. The slider steps through the footprint's versions. Next to
  it: the QC verdict (one status mark and a short label, with the reasons), where the
  cell sits, and the frame at which it was found.
- Its **QC metrics as bullet bars**, each on a fixed range; where a rule has a
  threshold, a tick marks it: peak SNR (log scale 1 to 100, tick at the pass level 5),
  neighbour r (tick at 0.8, the pair level), motion R² (tick at 0.2, the motion flag),
  then trace fidelity, crosstalk (vif) and max overlap (no threshold). Footprint error
  and events per minute have no absolute scale, so they are figures only. A grey dash
  means not measured yet.
- The **Trace** / **Demixing** switch picks the view below: **Trace** shows the whole
  session as an overview with a live detail window that takes the rest of the tab's
  height. The frames before the cell was found are shaded grey on both. **Demixing**
  shows the overlapping neighbours.

The arrows step through the cells by id. With no cell selected, the tab lists the
cells with the highest peak SNR, each with its status mark and SNR bar; click one to
select it.

**The other tabs.** **QC** (the cell table, see
[Reading the quality-control indicators](#reading-the-quality-control-indicators); click
a row to select the cell; its sort, filter and columns stay while you look at other tabs), **History** (see below), and under **More**:
**Correlation** (the
pairwise trace correlation against distance plot; see below), **Flat field**,
**Timing** (per-stage times and the slow loop's counters), **Raw file** (scrub the
recording as read from disk) and **Recording** (the recording's facts, with any warning
about them, such as a missing frame rate, as an amber line with a ⚠ above them).

**Timing tab.** Where the time per frame goes, as rows on one fixed log axis in ms
(0.01 to 1,000): the pipeline stages (one dot each, the mean per frame), then the fast
loop, online QC and slow loop over recent batches, each a bar from the mean to the max
with a dot at the 99th percentile and the figures mean · p99 · max beside it. The dashed
line on per-frame rows is the frame budget, the time one frame lasts at the recording's
frame rate: a stage to its right is slower than real time. A series with no samples is a
grey dash. Under them are the slow loop's counts (working set, adds, merges, refines,
rejects, library versions, reservoir size) and a meter of the frames it dropped. The tab
refreshes at most twice a second.

**Correlation tab.** A check for incomplete demixing of neighbouring cells. Until you
press **Compute** the tab shows the plot's empty axes. Press **Compute** (once, on
demand; it never runs with the pipeline, and **Recompute** repeats it): for every pair of cells it takes the Pearson correlation of their traces
(each minus a 15 s moving average) and plots the median per bin of centre distance,
in soma diameters D (the median equivalent diameter of the footprints at half
maximum), with the interquartile range as bars, over a faint scatter of the individual
pairs (r against the exact distance, 0 to 6 D). Every pair within 6 D is used and drawn
(thinned uniformly at random only on very large fields, and the note says so); points
above or below the plot are not drawn and are counted under it. Cells that share no signal sit near 0;
excess correlation at close range means light is shared between neighbours' traces.
The dotted line is the median r of far pairs (1.5-3 D apart), the level expected with
no leak. The y axis is fixed at -0.1 to 0.5 and widens (in 0.1 steps) only when a bar
falls outside it. After Extract the traces cover the whole recording; before that they
cover the frames each cell has been tracked.

## The History view: how the run evolves

Every quantity the run tracks is kept over the whole run, from a 5-minute file to a
5-day live stream, and drawn on one time axis (elapsed stream time: `m:ss`, then
`h:mm`, then days `d0`…`d5`).

- **Groups.** The Run tab shows **Convergence**. The **History** tab shows one group
  at a time: **Scales** (cell diameter, PSF and flatten σ, once the scale estimator
  lands), **Imaging** (noise σ and background, both the median over the field of
  view; flicker gain and offset; flat-field updates as stems), **Motion** (dy, dx,
  share of frames flagged, registration quality) and **Throughput** (processing rate,
  slow-loop lag, and for a live stream frames dropped per minute and live lag).
- **One plot per group.** Every series is drawn against its own fixed range, so they
  share one plot. The chips above it are the legend and the readout: click a chip (or
  a line, or use the arrow keys) to select a series. The selected one is drawn in
  full with its min/max envelope, and the y axis shows its units and range; the
  others are dimmed. Hover a chip for its full name, range and unit.
- **Hover** shows every series' value at that time, with the clock time. **Click**
  pins the time: the chips show the values then, in violet, and the Run tab shows
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
  the field of view moves into the History tab and stays live (selecting a cell there
  keeps you on the History tab). ⤡ restores it.
- **Old periods are coarser.** The newest hour is kept at 1 s resolution, older
  periods at 4 s, 16 s, 64 s and 256 s bins; each bin keeps its minimum and maximum,
  so a spike is never lost. About 9 MB covers 5 days. The per-frame motion and
  flicker are in the export at full resolution regardless.

## How a run works

A run has two named stages: **Discover** and **Extract** (see
[docs/stages.md](docs/stages.md)).

1. **Run starts Discover.** Opening a recording loads it and shows the pre-run sheet in
   the Run tab; pick the settings and press **Run**. The recording is walked in batches. Preprocessing and
   motion correction run in workers, so the page stays responsive. The field of view
   shows the frame being processed at the stage you pick, with the cells over it.
2. **Discover finds cells.** A slow loop looks for new cells and prunes bad ones
   while the fast loop extracts traces with the library as it stands. The traces
   emitted early were solved with the cells known at that moment. **End Discover**
   (■) ends it at the frames read so far.
   How many cells Discover finds depends on how often it revisits each part of the
   field of view (its **visit rate**), so Discover keeps that rate fixed, not tied to how
   fast the machine is: 0.15 refinement visits per frame. (An experimental **Auto** schedule,
   opt in with `?debug&visitrate=auto`, instead keeps 0.15 while new cells keep turning up,
   slides down to about 0.04 as they stop, and goes back up if new cells appear later.
   Once the field is mapped it saves visits (about half on a
   30,000-frame recording), but Discover is only a little faster for it (3–8 % at Max in our tests on long
   recordings, little on short ones), and it finds a few fewer cells: the late,
   rarely active cells that extra visits still pick up (1–2 % of matched cells on
   simulations, about 5 % of cells on real data), so it is not the default.) The Speed block's
   **Refinement** gauge shows the visits per frame achieved (0 to 0.5), the target in force
   ticked and the allowed band shaded; its tooltip says which schedule runs.
   Within the rate, a run never makes more than 4/3 and, on a recording, never fewer
   than 2/3 of its visits per frame: on a fast Speed setting or at **Max**, when the
   workers cannot keep up, the run is held slower than asked: the gauge turns amber and
   the Speed block says "Held at N fps to keep refinement up"; a slow or paced run no
   longer over-visits. The same recording then gives about the same cells at any speed
   and on any machine. A live stream cannot slow down, so it keeps only the upper limit.
3. **The Final settle ends Discover (recordings).** For a recording, Discover runs with
   **look-back**: it also re-reads earlier frames for each new cell, so footprints
   converge as it goes, and after the last frame it runs a **Final settle** (Thorough by
   default; pick Quick, Standard or Thorough under **Final settle**) before it publishes
   the final library. The status reads **Final settle** while that runs, and **Stop final
   settle** keeps what was refined so far. Look-back needs a recording on disk with
   one session; on a live stream or a Joint run of several sessions
   it is off and the Run tab says why (the footprints then get no refinement after
   Discover). Untick **Look-back refinement** or open the page with `?lookback=0` to
   turn it off. There is no separate Refine stage any more: look-back and the Final
   settle replaced it.
4. **Extract extracts traces.** It replays the recording with the final library, using
   the motion and flicker recorded during Discover, so a cell found late has a trace from
   frame 0. Run it with **Extract** once the footprints have settled. It starts by itself when Discover (and its Final settle) ends while **Extract after Discover** is on (the default); turn it off to inspect the footprints first.
5. **Export.** Once Extract has finished, the **Export** button on the run rail opens a menu with **Export (.npz)**, which writes the main file: traces (cells x frames), cell
   ids and centroids, sparse footprints, per-frame motion and flicker, per-cell QC,
   and a JSON block with the run's provenance and the stages that ran. It holds two
   trace matrices: `traces`, which never goes below 0 (a quiet cell sits at exactly 0),
   and `traces_signed`, the same traces without that clip, so a quiet cell's noise
   is centred on 0 and can go negative. **Export for CaDecon (N cells)** writes just
   the signed traces of the cells that pass QC (untick **QC-passing cells only** to include
   every cell), for CaDecon, which needs the zero baseline. Python:
   `np.load("<folder>_cala.npz")["traces"]` (or `["traces_signed"]`). A live run has no
   Extract and no signed traces. The `.npz` also holds a mean and a max
   image of the field of view (`fov_mean`, `fov_max`), the flat-field gain map
   (`flat_field_gain`, when one was applied), the run's history
   (`history_L0` … `history_L4`) and event log (`run_events_json`); see
   [Reading the run history in Python](#reading-the-run-history-in-python).

## Projects: one recording, an animal's sessions, a live stream

Everything Cala opens is a **project**, and every run writes its results the same way,
into the project's `calab-project/` folder next to the data (raw data folders are only
read). What you open decides how big the project is:

- **One recording folder** is a project with one session. It opens on the recording with
  its pre-run sheet; **Run** asks (in Chrome and Edge) for permission to save into the
  folder, then runs Discover, Extract and writes the results. **Project** in the header
  shows its table and results; **Restart** (↻) after a run ended starts a new run.
- **An animal folder** (for a Miniscope V4 tree, the folder that holds
  `date/time/My_V4_Miniscope/`) is a project with one session per recording folder, at
  any depth; behaviour cameras are left out (see above). It opens on its session table.
- **A live stream** (the live-source field) is a project with one session and no folder:
  its run starts on connect, and its results download as a zip when it ends.

The project's table:

- **If the folder holds several animals** (an experiment folder with one subfolder per
  animal, each with several sessions), the app offers to open one animal at a time.
  Pick the animal, or open everything as one project.
- **The session table** lists each session: its folder, date and time (from
  `metaData.json`), length, then whether **Discover** and
  **Extract** ran, the **Cell IDs** column, and the **current result**. Rows marked with
  the same letter in **Cell IDs** (and the same coloured edge) share cell ids: they come
  from one Joint run, so cell 7 is the same neuron in each. `own` means a session's ids
  are its own (a Separate run). **Results** on a row lists every result of that session
  with its run, date, cell count and file path.
- **Run plan.** Tick sessions, then **Run selected jointly** (one Joint run through them: one
  library, shared cell ids; Discover runs through all sessions in order, look-back re-reads
  frames of the session it is in, the Final settle at the end covers every session, and
  Extract solves each session with the final library) or **Run selected separately** (each
  its own run). Sessions of a Joint run must have the same size and bit depth. Repeat to
  build a plan, e.g. sessions 1 to 3 chained, 4 and 5 separately, 6 to 8 chained; and
  **Start plan**. **Discover settings** (Look-back, Final settle) under the plan are used
  by every run in it; choose them before **Start plan**. Chrome and Edge ask
  once for permission to save into the animal folder. The steps run one after another;
  each session's results are written, and its current result updated, as soon as it is
  done. If a stage fails or is cancelled the plan stops, keeps what is written, and
  leaves the unfinished steps in the plan. **Back to project** in the header returns to
  the table. A rig with two Miniscopes gives one session per Miniscope; run those as
  **Separate**.
- **Current result.** A session's newest result is its current one. Older results are
  kept; **Set current** in its results makes an older one current again.
- **View results.** Opens a result in the viewer as it looked right after its run:
  the cells over the field of view (**Mean** or **Max** image), the QC table, a
  clicked cell's footprint and trace, the History plots and event log, the stages that
  ran and the flat field, in the same tabs (the first, **Result**, says what was
  saved; the strip shows the traces being read). It is read-only: to Discover or Extract again, start a new run
  from the table. **Back to project** returns to the table. Results saved by older
  versions open too; what they lack (the images, the History) says "not in this
  export".
- **Where results go.** Each run gets its own folder below `calab-project/runs/`, with
  each session's export at the session's path (a single recording's at the run folder's
  root):

  ```
  calab-project/
    calab-project.json                     the project: its sessions and the plan
    calab-index.json                       a cache of the runs (rebuilt when lost)
    runs/2026-11-28_09-14-03_cala/
      calab-run.json                       the run: settings, inputs, stages, results, record
      2026_11_10/14_02_33/My_V4_Miniscope/
        cala-export.npz                    the usual export, for this session's frames
  ```

  **Choose another folder...** saves the results elsewhere. A renamed session folder is
  recognised by its start time and frame count; a folder that is gone is marked missing.
  Results of older Cala versions (`cala-results/`) are named in a warning and not read.

- **Reopening.** Chrome and Edge list **Recent projects** on the start screen: one click
  (and a permission prompt) reopens one. Other browsers pick the folder again; there each
  run downloads a zip of its run folder (with the project file), to unpack into the
  picked folder.
- **Saved in browser storage.** Until the project file can be written to the folder (before
  the first Run's permission, or always in Firefox and Safari), the plan, the project
  defaults and the session settings are kept in the browser, and come back when the same
  folder is opened again, even after a reload. In Firefox and Safari a run's file is also
  kept in the browser until its zip downloads: if the tab closes or crashes during the run,
  the next open of the project offers **Download run file**, and the step it was running
  stays in the plan.

Saved libraries (applying one session's cells to another) and matching cells across
Separate runs come in later versions. Details:
[docs/projects.md](docs/projects.md).

### Joint runs: session boundaries

In a Joint run the History plots and the cell trace mark where each session
starts. At each boundary cala lines the new session up with the previous one (it
finds a rotation of up to 3° and a shift of up to 40 px), and adjusts its background
and noise estimates to the new session's brightness, so a change of LED level or a
remounted scope does not show up as a baseline bump in the traces. The run's History
lists what was done at each boundary ("session boundary"). The cells' brightness is
not equalised between sessions: if the light changed, traces stay in camera units.

cala also checks each boundary and flags it **ok**, **warning** or **failed**, with the
reason (hover the badge). It looks at three things, each against what the same
recording does within a session: whether the new session lines up with the previous
one (a failed alignment usually means the sessions do not show the same field of
view, or moved further than cala searches); whether the brightness and noise
corrections held over the next 30 s; and whether the cell library carried over (a
burst of new cells, or many cells going silent at once, after the boundary). The
outcome checks need 30 s after the boundary, so the flag says "ok so far" until then.
The flag shows on the session's row in the project table, in the run's session list,
in History ("boundary check"), on the cell trace's boundary line (orange: warning,
red with "!": failed) and in the saved results. For a failed boundary, run those
sessions **Separate** instead: **Re-plan as Separate** on the badge puts them into the
run plan that way (it never switches by itself).

## Reading the quality-control indicators

**Convergence status** (Run tab header, with the convergence plot below it). Cell discovery does not stop on long
recordings, so "converged" means the cells already found stopped changing, not that
no new cells appear.

- **Waiting for cells**: nothing to judge yet.
- **Discovering cells**: less than two minutes of history, or most cells are under a
  minute old.
- **Cells still changing**: some cells' footprints or traces are still changing against 1 to 2
  minutes ago, or churn is high. The line says how many.
- **Converged**: at least 85% of cells are stable and churn is under 3.5% of the
  library per minute, over the last two minutes. The rate of new cells is shown but
  never blocks this. It says nothing about cells Cala cannot see.

**QC tab.** At the top, a bar splits the cells into **pass**, **fail** and **not
measured**; the buttons under it carry the counts and filter the table (click the
active one again, or **All**, to show every cell; a click on the bar's part does the
same). One row per cell, failing cells first: the cell id with its status mark (a
dot: pass, a diamond: fail, a ring: not measured), its peak SNR as a bar with the pass
threshold tick, then four key columns: **Flag** (why it is flagged: low SNR,
duplicate?, pair, motion), neighbour r (with a link to that neighbour), trace fidelity
(proj r) and motion R². **Columns ▾** adds the others (vif, footprint error, events
per minute, age, still moving, slow-loop status). Figures are right-aligned. A cell is
**not measured yet** until it has about a minute of trace history. The pass/fail rule is: peak SNR of
at least 5, and not the weaker of two overlapping cells whose traces correlate above
0.8. During Discover the peak SNR is read on each cell's last minute of trace (in
seconds, at the recording's frame rate). After Extract, it is
recomputed on the extracted traces over the whole recording (over
each session in that session's export). Before, the table kept the last minute of Discover. A clean cell that happens
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
- The **Flat field** tab shows the map on a fixed 0.9 to 1.1 scale, with a badge for its
  state (Estimating, Estimated, Reused, Skipped, Off). Until there is a map the image is a
  striped placeholder and a **First map** meter counts the seconds of recording seen,
  out of 150.
  The flat field is on by default. To run without it, untick **Divide out the
  sensor gain map** (takes effect at the next Restart) or open the page with
  `?flatfield=0`.
- The map is cached in your browser (IndexedDB) so the next recording from the same
  sensor starts corrected. The cache key is a serial number from `metaData.json`
  when it has one. Stock Miniscope metadata has none, so the key is then the folder
  name, and a renamed folder starts from scratch. A map is never reused for a
  different frame size.
- Extract uses Discover's newest map from frame 0.

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

## Sharing a recording

The **Run** tab of an opened recording (not a live source) has a **Share recording**
button, shown when the app is connected to the CaLab community backend. You choose how it is
shared: **public on DANDI** (CC BY 4.0, citable; after review it appears in the CaLab shared
recordings collection and under **Browse shared recordings** on the start page, where anyone can
download it) or **CaLab only** (only the team uses it to develop and benchmark cala). Nothing is
uploaded until you sign in with your email, fill in the form (indicator, species, brain region,
scope, and for public recordings subject details) and tick both consent boxes. The raw frames are
then compressed without loss in the browser (about 1.65x smaller, up to 10 GB per shared recording) and
uploaded with `timeStamps.csv` (if the recording has one) and the file names, never folder paths.
**My shared recordings** lists what you sent, whether it is in the benchmark, and lets you withdraw
it until the lab has taken it in. After that, contact the CaLab team to have it removed. A
public recording can be removed until the next version of the DANDI collection is published;
published versions are permanent.

## Known limitations

- **Beta.** Expect rough edges, and check the results against your own data.
- **Footprints still changing.** At the end of a 20-minute pass about 1 footprint in 10
  may still be changing; the convergence status in the Run tab says where a run stands.
- **Somatic footprints only.** Cala looks for compact, single-peaked cell bodies, not
  dendrites or neuropil.
- **Gain stability over days is untested.** The cached flat field assumes the sensor's
  pixel gain does not change between sessions; this has not been checked across days.
- **Offline throughput.** Throughput depends on the machine and on whether WebGPU is
  available. On an Apple-silicon laptop, Chrome with WebGPU ran roughly 175 to 215
  frames/s on a 600 x 600 recording and CPU-only runs about 110 to 160. Extract
  repeats the walk, so a long recording takes a while.
- **Live acquisition is experimental.** The live-source field on the start page
  streams frames from a WebSocket (see the README). Apart from
  [testing with a simulated stream](#testing-with-a-simulated-stream), it is not
  covered by this guide. A stream keeps its factors in the browser's storage, about
  55 MB per 1,000 frames at 600 x 600 (about 2 GB for 30 minutes at 20 fps), with no
  check of free space; if a write fails, the stream ends with Discover's cells and
  traces, without the Final settle and Extract. Its export is format version 7 and
  holds the live traces as `traces_live` beside Extract's `traces`.
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
