# Whole-history scan on the compressed factors

Can the compressed session history (`crates/cala/src/compress`) show cells the slow loop
missed? The add test judges a candidate on the few frames a tile's reservoir holds; a dim
cell is invisible there but repeats over minutes. This is an offline probe of a review that
uses the whole history instead. Nothing here changes discovery.

## Inputs → outputs

```sh
# 1. a run that also writes the factors (600-frame windows, CALAFAC1)
discover_eval real RAW RUN --motion --fps F --factors-out RUN/factors
# 2. test every 4th pixel in the field of view  ->  RUN/history_wholetest_scan.tsv
python tools/cala-diagnostics/history_wholetest.py RUN --scan 4 --keep-known-activity \
    --out history_wholetest_scan
# 3. candidates, scored against other pipelines (or --truth TRUTH.npz for a sim run)
python tools/cala-diagnostics/history_review_score.py RUN --ref minian=UNITS.npz
```

`qc_eval` takes `--factors-out` too. A review during the session is emulated with one
directory per checkpoint frame `F`, holding the library and the windows as they were then:

```sh
mkdir -p RUN_tF/factors && ln -s RUN/fp_F.bin RUN_tF/footprints.bin
# link every RUN/factors/w<start>.fac with start + 600 <= F, then scan RUN_tF as in step 2
```

## Method

At each spot the frames of a 29 px patch are rebuilt from the factors, and the library's
cells and a smooth background are removed by least squares. The windows are split into two
halves (even, odd). Each half gives the leading spatial pattern of what is left. A spot is a
candidate when the two patterns agree and are cell-shaped, and one half's pattern has
events in the other half's frames. Thresholds are in MADs of the same statistics at spots
far from every library cell, so the session is its own noise reference (rule in
`history_review_score.py`).

## Results

Measured before the online sensor flat field (#330); real data used an equivalent
fixed-pattern correction ahead of motion correction. Without it the sensor pattern is most
of the stored history (68 % on V4) and the scan finds 0 to 1 candidates.

Real V4, 20 min, 620 cells in the library:

| history used | candidates | on a Minian or CaImAn unit |
| ------------ | ---------- | -------------------------- |
| 2.5 min      | 9          | 6                          |
| 5 min        | 25         | 19                         |
| 10 min       | 47         | 42                         |
| 20 min       | 72         | 67                         |

Of the 72, 12 lie within 5 px of a cell already in the library. The candidates' traces
follow the matched reference unit's (r 0.71; 0.01 for a control).

Review during the session (library and history as they were at 3.5, 7.5 and 11.5 min, plus
the end), real V4:

|                                  | end only | during the session |
| -------------------------------- | -------- | ------------------ |
| candidates                       | 72       | 136                |
| on a reference unit              | 67       | 120                |
| ... found later by the slow loop | -        | 51                 |
| ... never found by it            | 55       | 69                 |
| not on a reference unit          | 5        | 16                 |

Synthetic truth, end of session (candidates / true cells the run missed among them):
30 min 19 / 10, 20 min 11 / 6, low SNR 6 / 4. The false ones are copies of library cells,
out-of-focus cells and a few empty spots.

Wireless sessions (200 x 200): 0 to 2 candidates.

## Not covered

- The review is not in the slow loop: candidates are not added to the library and their
  traces are not back-filled.
- Cost of the scan in the browser.
