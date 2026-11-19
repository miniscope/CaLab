# Cluster replay in worker jobs

18 Nov 2026. Branch `feat/cala-replay-worker-jobs`, on main 6752419b (Stage 2, #424). Before this, a refine visit run as a
`VisitJob` carried no cluster stores, so `refine_clusters` found none and the visit fell back to the per-cell path: in the
browser app (whose slow worker hands every visit to a `VisitRunner`) `SlowLoopConfig::joint_update` never replayed. The flag
stays off by default.

## Design

- The **owner** (the `SlowLoop` that observes every frame) keeps all stores; frames keep being pushed into them while a job
  is out. A job carries only the stores of the clusters **its tile owns** (first member's centre in the tile's core) and can
  replay (every member within 2 px of the tile's rectangle, the replay's own reach test with a guard), and only for a
  visit that refines (`refines_on`; an idle Refine visit carries none). For the other clusters of its cells it carries
  member ids and the `ok` flag (the visit reads those to decide which cells the per-cell refinement skips).
- A store travels as: member ids, disks, pixels, whitening, owner and cover masks, library version, the members' columns,
  the forgetting sums (`CY`, `Σr`, `Σc`, `Σcc`, `Σw`), the basis `U` (f64; the f32 copy is rebuilt), the ring history
  (frames newest first: coordinates, push index, split-half block; the empty ring tail is not sent), the push count and
  the carried estimate. `ClusterStore::encode/decode` in `cluster.rs`, in the job's byte style (`wire.rs`; magic `VIS9`).
  The decoder checks every length and returns `None` on a short or inconsistent buffer.
- The **runner** installs them, runs the unchanged visit (`refine_clusters`: replay, proposal, support/inversion, joint
  gate with the tile's held-out frames, which the job holds anyway) and returns, as ordinary ops, the accepted members'
  `Replace` edits. So the main thread's gate-and-commit is the existing `apply_job`, in order; the proposal is not a
  separate message because the gate needs the tile's reservoir, which lives in the job.
- Per owned cluster the result also carries a `ClusterOut`: the `ok` flag, whether the replay refreshed the basis, and
  the carried estimate (`joint_carry`) with the pixel set it is on. The owner re-does the cheap basis refresh on its own
  current store (identical to the replay's own when no frame arrived in between, and the right one when some did: the
  stored frames, including the new ones, are re-expressed together) and takes the estimate if its pixel set is
  unchanged. The joint-update counters the visit moved (`replays`, `low_snr`, `proposals`, `accepted`, ...) come back and are added.
- Not changed: `merge()`, the flag-off path (a job of a loop without the joint update carries no clusters; the encoding
  gains one zero count).

## Equivalence

`qc_eval sim ... --passes 2 --later-passes refine --batch 8 --budget 30000000 --slow-seed 1 --dump --no-heldout
--no-signed --joint-update refine --joint-sign all`, in process vs `--via-jobs` (`step_via`: every visit through the
byte encoding of job and result, in the order `step` visits; no scheduling, so it is deterministic and must be identical):

| sim       | files compared                                                                | result    | replays | accepted | members replaced |
| --------- | ----------------------------------------------------------------------------- | --------- | ------- | -------- | ---------------- |
| static_s5 | footprints.bin, footprints_pass1/2.bin, final.tsv, final_pass2.tsv, cells.tsv | identical | 7483    | 2295     | 6526             |
| pairs_s5  | footprints.bin, footprints_pass1/2.bin, final.tsv, final_pass2.tsv            | identical | 5195    | 722      | 1367             |

The joint-update counters match field for field. Before this change `--via-jobs` gave 0 replays. Flag off (no
`--joint-update`), main 6752419b vs this branch on static_s5, same flags: `footprints.bin`, `footprints_pass1/2.bin`,
`final*.tsv` and `cells.tsv` byte-identical.

With real visit workers (`--visit-workers K --offered-fps R`, or the app) results legitimately differ from `step`: a
visit sees the owner as it was at hand-out while frames keep arriving, and visits finish out of order. That is the
same for the per-cell path; see the timed check below.

Rust tests: `a_store_round_trips_through_the_job_encoding` (lossless, same replay bit for bit with a wrapped ring,
truncation and corruption refused), `a_replay_on_a_copy_and_its_out_equal_the_replay_in_place`,
`the_cluster_replay_runs_in_visit_jobs_and_matches_step` (bitten-newcomer toy, with and without `joint_carry`: libraries
equal frame by frame, counters equal, stores really replayed in the runner).

## Transfer and main-thread cost (static_s5 / pairs_s5, Refine pass, release build, Apple silicon)

| per job with a replay                         | static_s5 (322 cells in 114 clusters) | pairs_s5 (66 in 33) |
| --------------------------------------------- | ------------------------------------- | ------------------- |
| store bytes, mean (one store per replay)      | 189 KB                                | 127 KB              |
| store bytes, max                              | 699 KB                                | 206 KB              |
| owner: copy the store into the job            | 15 us                                 | 12 us               |
| owner: apply the `ClusterOut` (basis refresh) | 81 us                                 | 37 us               |
| owner: encode the store (microbenchmark)      | about 15 us per 130 KB                |                     |
| total over the Refine pass                    | 0.12 s copy + 0.60 s apply of 457 s   |                     |

The result carries the `ClusterOut`s (a few bytes per cluster; the carried estimate adds `8 n K` bytes only with
`joint_carry`). Peak bytes of all stores on the owner: 32.7 MB (static_s5), 6.4 MB (pairs_s5), as in process. Browser
timing (postMessage of 0.2-0.7 MB per refine job, worker decode) is not measured here.
