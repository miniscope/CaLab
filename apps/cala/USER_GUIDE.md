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
  is there for odd layouts.

## Browser requirements

| Browser                | Status                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chrome, Edge (desktop) | Recommended. WebGPU motion correction when a GPU is available, and a save dialog that writes exports straight to a file you choose.                    |
| Firefox, Safari        | Run the full pipeline with motion correction on the CPU. Exports are built in the browser's private file system and handed to the download.            |
| Any browser, no WebGPU | Motion correction falls back to the CPU. The status bar badge says **Motion: CPU** or **Motion: WebGPU**. Throughput is lower; the method is the same. |

Needed in any browser: WebAssembly, module Web Workers, and the folder picker
(`<input webkitdirectory>`). Several CPU cores help: cell discovery uses the spare
ones. If the browser has no origin private file system (OPFS), pass 2 holds its traces
in memory, up to 1.5 GB, and says so with an error when a recording does not fit.
Use a desktop browser; a laptop with enough free RAM for the cell library and a
few batches of frames is plenty.

## How a run works

1. **Opening starts pass 1.** The recording is walked in batches. Preprocessing and
   motion correction run in workers, so the page stays responsive. The video panel
   shows raw or preprocessed against motion-corrected frames, and the cell overlay.
2. **Pass 1 discovers cells.** A slow loop looks for new cells and prunes bad ones
   while the fast loop extracts traces with the library as it stands. The traces
   emitted early were solved with the cells known at that moment.
3. **Pass 2 extracts traces.** It replays the recording with the final library, using
   the motion and flicker recorded in pass 1, so a cell found late has a trace from
   frame 0. It starts by itself when pass 1 ends (checkbox), or with **Run pass 2**.
   **Finish pass 1 now** ends discovery at the frames read so far.
4. **Export.** Once pass 2 has finished, **Export (.npz)** writes the main file: traces (cells x frames), cell
   ids and centroids, sparse footprints, per-frame motion and flicker, per-cell QC,
   and a JSON block with the run's provenance. **CaDecon export** writes just the
   traces of cells that pass QC, for CaDecon. Python:
   `np.load("<folder>_cala.npz")["traces"]`.

## Reading the quality-control indicators

**Convergence strip** (top of the page). Cell discovery does not stop on long
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
  recorded in the run (status panel, export `meta_json`). Later refinements come about
  every 60 s and are small.
- The **Flat field** tab shows the map on a fixed 0.9 to 1.1 scale and its status.
- The map is cached in your browser (IndexedDB) so the next recording from the same
  sensor starts corrected. The cache key is a serial number from `metaData.json`
  when it has one. Stock Miniscope metadata has none, so the key is then the folder
  name, and a renamed folder starts from scratch. A map is never reused for a
  different frame size.
- Pass 2 uses pass 1's newest map from frame 0.

## Known limitations

- **Beta.** Expect rough edges, and check the results against your own data.
- **Footprints still changing.** At the end of a 20-minute pass about 1 footprint in 10
  may still be changing; the convergence strip says where a run stands.
- **Somatic footprints only.** Cala looks for compact, single-peaked cell bodies, not
  dendrites or neuropil.
- **Gain stability over days is untested.** The cached flat field assumes the sensor's
  pixel gain does not change between sessions; this has not been checked across days.
- **Offline throughput.** Throughput depends on the machine and on whether WebGPU is
  available. On an Apple-silicon laptop, Chrome with WebGPU ran roughly 175 to 215
  frames/s on a 600 x 600 recording and CPU-only runs about 110 to 160. Pass 2 repeats
  the walk, so a long recording takes a while.
- **Live acquisition is experimental.** The live-source field on the start page
  streams frames from a WebSocket (see the README). It is not covered by this guide.
- **Everything stays in the tab.** Closing the page discards a run that was not
  exported.
