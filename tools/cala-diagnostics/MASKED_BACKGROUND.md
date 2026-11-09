# Masked-background experiment, fixed before new scores

Compare original and no-local-bump backgrounds with two exterior-fit candidates.
The exterior-fit candidates use the candidate's entire nonzero signed support,
with either zero or three pixels of Euclidean dilation. Only valid FOV pixels
with positive inverse noise are used. No mask threshold or penalty is tuned.

Fit the captured signed ten-column native background and nonnegative known
neighbor cells on the exterior. Freeze that background prediction. Refit
nonnegative cells on the heldout interior in nested target-present and
target-absent fits; both use exactly the same frozen background. Neighbors can
compete in both fits. Score the interior RSS decrease divided by
max(interior full RSS / nominal interior residual dof, 1). Report raw RSS gain
as well. Nominal dof and calibrated scores have no asserted native null law.
Original/no-bump reference fits retain their previously declared full-FOV score.
Thresholds are separately calibrated for each complete scoring procedure.

Report exterior background identifiability after projecting out neighbors,
conditioning, mask/exterior sizes, prediction noise amplification, and GT energy
outside each mask. Reject unidentifiable exterior background predictions;
report coverage explicitly without substituting a favorable model.

Six frozen geometries are listed in geometries.json. Developmental early/late
ID18 geometries supply calibration and evaluation draws. Four retained-cell
geometries supply evaluation draws only. They are selected survivors, not an
unbiased population sample. Calibration thresholds pool only developmental
negative controls, then transfer unchanged to other cells.

Independent spatial control families and common positive amplitudes follow
background_controls.py. Fresh master seeds are 2026110901 for calibration and
2026110902 for evaluation. Each geometry/split uses 128 negatives per family
and 64 positives per SNR. Whitened noise remains quantized to 1/32, matching the
previous control protocol rather than native 1/16. GT is aligned into working
coordinates by subtracting the evaluator's working-to-GT offset before cropping.

Replay the four developmental probes and 59 additional existing captured probes.
These correlated, selected probes describe mechanism and transfer; they do not
estimate independent production sensitivity. Unexplained outputs are not proven
negatives. Native probe selection and sequential ledger history remain omitted.
No detector source or production threshold is changed by this experiment.

## Running the portable tools

Dependencies: NumPy, SciPy, Matplotlib (the existing independent control generator imports it).

```sh
python tools/cala-diagnostics/masked_controls.py --manifest geometries.json --out results
python tools/cala-diagnostics/masked_controls.py --manifest new_geometries.json \
  --calibration-results results --out transfer
python tools/cala-diagnostics/replay_masked.py --manifest captures.json \
  --metrics results/metrics.tsv --out replay
```

Geometry manifests are lists with `label`, `snapshot`, `gt_footprints`, `gt_id`,
`gt_offset: [dy, dx]`, `splits: ["calibration", "evaluation"]` (or evaluation
only), and optional `spatial_role`. Input paths can be absolute or relative to
the manifest. Replay manifests contain `label`, `capture`, and `category`.
`capture` is one keep snapshot or a directory containing keep_* directories.
External calibration rejects incompatible protocol/source hashes and incomplete
negative calibration strata; only its calibration rows enter threshold fitting.

The guard requires all exterior background coefficients to be identifiable
after removing the span of exterior neighbors. It is conservative: coefficient
ambiguity is rejected even if its interior prediction would be unique. Failure
is recorded, never silently replaced by a more favorable arm. Linear prediction
noise diagnostics assume iid unit whitened noise and unconstrained neighbor
nuisance coefficients; they are not an unconditional NNLS variance estimate.

## Initial outcome

12,800 seeded cases (51,200 scores), eight geometries, and 80 captured probes
were evaluated. Only developmental early/late geometries supplied calibration.
Two additional full 4,800-frame captures from different cells reproduced baseline
footprints exactly. Those cells were chosen by the lowest detector ID with final
simulated match r>=0.9, before examining masked scores.

At the old reference cutoff, pure noise passes in 47/1,024 original,
401/1,024 unpadded masked, and 431/1,024 padded masked cases. Separately calibrated
1% negative-mixture cutoffs are about 441.5, 13,774.4, and 14,646.7 respectively.
Both masked arms recover 0/512 SNR20 injected positives at those cutoffs and
0/80 captured probes. The unpadded arm's 4/4 rescue of original development
probes at the old cutoff therefore does not justify adopting it.

The native background basis extrapolates noisily into the masked hole.
Linear prediction-noise spectral amplification across the initial six geometries
is about 5.7–11.5 without padding and 10.4–22.9 with padding. This is an operator
reference, not a measured unconditional estimator variance. All tested geometries
pass the conservative rank guard: numerical identification alone is insufficient.
No production change is warranted. These findings apply to the fixed basis and
score tested; they do not establish that every exterior prediction method fails.
