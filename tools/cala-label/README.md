# cala-label: blind labelling of candidate footprints

A small, temporary tool for labelling candidate cells without knowing where they
came from. One page (vanilla JS, no build, no network), a stdlib server that
appends labels to `labels.jsonl`, and a script that builds the bundle.

Per candidate it shows the footprint, the mean image with the footprint contour,
the trace, and a looping video snippet around three strong events. It shows
nothing else: no id, no score, no build or run, no Minian match.

## Keys

| Key                | Action                                                                                |
| ------------------ | ------------------------------------------------------------------------------------- |
| `c` / `n` / `u`    | cell / not a cell / unsure (saves and moves on)                                       |
| `m`                | toggle the flag "merged (two cells)" before pressing `c`/`n`/`u`                      |
| `e`                | toggle the flag "edge, partly outside"                                                |
| `z`                | undo the last label                                                                   |
| `space`            | pause or play                                                                         |
| `1` `2` `3`        | loop only that event (`0`: all three again)                                           |
| `x`                | max projection or mean of the crop (default max; max is over the three event windows) |
| `k`                | contour on or off                                                                     |
| `r`                | processed or raw registered video and mean image                                      |
| left / right arrow | previous or next candidate without labelling                                          |
| `+` / `-`          | playback speed (default 0.5x, 10 fps)                                                 |

Progress shows as `labelled / total`. Closing the browser or stopping the server
loses nothing: the next start opens at the first unlabelled candidate.

## Display rule: nothing is auto-scaled

Every grey value and every trace in the bundle is drawn with one fixed range for
the whole bundle (printed by `render`, saved in `items.json`): the sprite sheets
use the 1st to 99.5th percentile of all snippet pixels, the traces the 0.1st to
99.9th percentile of all candidate traces. A dim cell looks dim and a strong
event looks strong. The footprint panel is the exception by necessity: its scale
is arbitrary (footprint times trace), so it is shown as a shape with peak = 1.
The sprite sheets use 32 grey levels to keep the bundle small.

## Run it

```bash
python tools/cala-label/serve.py <bundle dir> --port 8765   # then open http://127.0.0.1:8765/
```

## Build a bundle

1. `select`: pool the cells of several `qc_eval real` runs (each with
   `footprints.bin`, and `ana.tsv` for the texture and two-peak flags), plus the
   Minian components that no run matched at r >= 0.5. Cells that match across runs
   at r >= 0.7 count once. Strata for 300 candidates: 80 flagged (texture,
   two-peak, within 10 px of the image border), 60 found by only some of the runs,
   60 Minian-only, the rest uniform; a shortfall goes to uniform. Order is shuffled.

   ```bash
   python tools/cala-label/make_bundle.py select --runs RUN1 RUN2 RUN3 \
       --minian .../minian_out/A.zarr --n 300 --seed 1 --out work/
   ```

2. Cut the crops (about 8 minutes for 18 000 frames, 0.7 GB RAM; the recipe flags
   must match the run that made the footprints, here `--motion`):

   ```bash
   cargo run --release --example qc_eval -- real <avi dir> raw/ --motion \
       --frames 18000 --label-bundle work/candidates.tsv
   ```

   Every candidate gets the same trace: its footprint projected on the flattened,
   floored frame. Events are the three highest peaks at least 5 s apart. Crops
   are 60 x 60 px, snippets 30 frames either side of each peak.

3. `render`: sprite sheets, traces, `items.json` (opaque ids, shuffled order and
   the fixed ranges) and `manifest.json` (provenance):

   ```bash
   python tools/cala-label/make_bundle.py render --select work/ --raw raw/ --out bundle/
   ```

   Needs numpy and Pillow; `select` also needs zarr for Minian.

## Labels

`bundle/labels.jsonl`, one line per action:
`{"cid", "label": "cell|not|unsure|null", "merged", "edge", "ms", "ts", "session"}`.
The last line per `cid` wins; `null` is an undo. The page also keeps unsent lines
in `localStorage` and resends them. Provenance is in `manifest.json`, which the
server never serves; `make_bundle.py resolve bundle/` joins the two (writes
`resolved.json`, prints counts per label and stratum).

`pytest tools/cala-label` runs the tests.
