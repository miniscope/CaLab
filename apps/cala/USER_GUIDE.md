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
- Runs a second pass that re-solves every frame with the final cell set.
- Shows quality-control indicators while it runs, and exports the result as NumPy
  `.npz` files.

## What you need

A **Miniscope V4 recording folder**: `0.avi`, `1.avi`, ... (sorted by number), plus
the sidecars `metaData.json` and `timeStamps.csv` if you have them.

- The frame rate comes from `timeStamps.csv`, else from `metaData.json`. The frame
  rate in the AVI header is ignored (real 20 fps files declare 60). The Recording tab
  shows which source was used.
- With neither sidecar, the recording still opens and plays back at an assumed 20 fps,
  but time-based settings and the exported sampling rate then rest on that assumption.
  Keep the metadata with your recordings.
- Files with a prefix (`neural_metaData.json`, `neural_timestamp.csv`) are recognised.
- Open the folder with the picker, or drop it on the page. **Choose individual files**
  is there for odd layouts. Files are read locally and never leave your computer. In
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
ones. If the browser has no origin private file system (OPFS), pass 2 holds its traces
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
convergence status, with icon buttons to pause (⏸), restart (↻) and end pass 1 or
stop the live run (■). Below it: the time-window control (**Run** and, when the run is
long enough, **24 h**, **1 h**, **10 min**, **1 min**), the whole-run strip, and one
overlaid plot of the convergence metrics (cells, new cells per minute, churn, stable,
explained, residual). Collapsing the panel folds the plot away. Below the plot:
pass 2 progress, **Discover cells**, **Pass 2 after pass 1**, **Run pass 2** and the
**Export** menu. In a narrow window the passes show as a stepper (Calibrate, Pass 1,
Pass 2, Export) and the metrics as small tiles on the same fixed ranges.

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

1. **Opening starts pass 1.** The recording is walked in batches. Preprocessing and
   motion correction run in workers, so the page stays responsive. The field of view
   shows the frame being processed at the stage you pick, with the cells over it.
2. **Pass 1 discovers cells.** A slow loop looks for new cells and prunes bad ones
   while the fast loop extracts traces with the library as it stands. The traces
   emitted early were solved with the cells known at that moment.
3. **Pass 2 extracts traces.** It replays the recording with the final library, using
   the motion and flicker recorded in pass 1, so a cell found late has a trace from
   frame 0. It starts by itself when pass 1 ends (**Pass 2 after pass 1**), or with
   **Run pass 2**. **End pass 1** ends discovery at the frames read so far.
4. **Export.** Once pass 2 has finished, the **Export** menu has **Export (.npz)**, which writes the main file: traces (cells x frames), cell
   ids and centroids, sparse footprints, per-frame motion and flicker, per-cell QC,
   and a JSON block with the run's provenance. **Export for CaDecon (N cells)** writes just
   the traces of the cells that pass QC (untick **QC-passing cells only** to include
   every cell), for CaDecon. Python:
   `np.load("<folder>_cala.npz")["traces"]`. The `.npz` also holds the run's history
   (`history_L0` … `history_L4`) and event log (`run_events_json`); see
   [Reading the run history in Python](#reading-the-run-history-in-python).

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
0.8.

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
- Pass 2 uses pass 1's newest map from frame 0.

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
  frames/s on a 600 x 600 recording and CPU-only runs about 110 to 160. Pass 2 repeats
  the walk, so a long recording takes a while.
- **Live acquisition is experimental.** The live-source field on the start page
  streams frames from a WebSocket (see the README). Apart from
  [testing with a simulated stream](#testing-with-a-simulated-stream), it is not
  covered by this guide.
- **Everything stays in the tab.** Closing the page discards a run that was not
  exported.

## Reading the run history in Python

The `.npz` export (format version 2) holds the History view's bins and the run's
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
