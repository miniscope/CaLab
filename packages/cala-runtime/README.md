# @calab/cala-runtime

Browser-side orchestration primitives for the CaLa streaming demixing
pipeline. Workers (decoder, fit, extend, archive) import channel and
protocol types from here; numerics live in `@calab/core` (and the
`cala-core` WASM build).

Reference: `.planning/CALA_DESIGN.md §7` — worker topology, channel
design, mutation queue protocol, asset snapshot protocol.

## Module map

- `channel.ts` — SAB-backed single-producer/single-consumer ring for
  frame data (decoder → fit, fit → extend). [landed, task 15]
- `mutation-queue.ts` — bounded drop-oldest ring (extend → fit).
  [landed, task 16] Single-threaded TS port of the Rust `MutationQueue`.
- `asset-snapshot.ts` — extend↔fit snapshot request/ack protocol with
  correlation ids and ack-timeout diagnostics. [landed, task 17]
- `events.ts` — `PipelineEvent` bus (birth / merge / split / deprecate
  / reject / metric) with drop-oldest backpressure, consumed by the
  archive worker. [landed, task 17]
- `worker-protocol.ts` — orchestrator↔worker message union imported by
  the four worker bootstraps (tasks 21-23). [landed, task 18]
- `orchestrator.ts` — `createRuntime(cfg)` spawns the four workers via
  caller-provided factories, wires channels, owns the epoch counter,
  and exposes `RuntimeController` (run/stop/state/onStatus/onEvent/
  epoch/stats) to the app layer. Two-pass replay is scaffolded in the
  config shape but deferred to Phase 7. [landed, task 18]

Phase 5 runtime surface is complete: the four-worker bootstrap and the
`apps/cala` run-control layer in tasks 20-23 consume this package
unchanged.
