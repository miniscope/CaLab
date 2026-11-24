# cala factors, slice 4: a live stream settles and extracts on its factors by default

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a live stream with Discover is a factor run without any switch: it compresses on the offset grids, and after
it ends the Final settle and Extract read its factors (what `?factors` does today). `?factors=0` runs a stream as
before this slice. Recordings do not change: they re-read the file, and `?factors=file` stays an experimental opt-in.

**Architecture:** no new mechanism. The page's switches are read once by a new pure function (`factorsFromPage`);
`factorRunPlan` gains one input (`factorsDefault`) and is otherwise unchanged. The compress worker is created on every
page unless `?factors=0` (it stays idle on a recording that does not compress); the pipeline store learns whether
`?compress` was asked, instead of reading it from the compress store's presence.

**Tech Stack:** TypeScript with SolidJS and vitest (`apps/cala`), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-11-23-cala-factors-on-settle-design.md` ("Decided by the owner"); slice 1's plan
("Later slices" → "Slice 4"). Evidence: `tools/cala-eval/results/2026-11-24-settle-factors.md` (`STR-F` passed every
line against `STR-0`), `2026-11-23-factors-live-speed.md` (a 20 fps stream keeps pace),
`2026-11-23-factors-file-speed.md` (one compress worker is 4-5x slower than Discover reads a file; factors bring no
settle or Extract speed gain on a file).

**Base:** `feat/cala-factors-file` (PR #495, open). The PR goes to `main` if #495 has merged by then, else to
`feat/cala-factors-file`.

## Decided (owner, 23 Nov) and what changes for a user

1. **Stream default.** A live stream with Discover on is a factor run without any switch. `?factors=0` turns it off
   (the stream ends at Discover's library, as before). `?factors` and `?factors=file` on a stream mean the same as the
   default.
2. **File default unchanged.** A recording re-reads the file. `?factors=file` stays experimental; `?factors` on a
   recording stays a `?compress` run (plain tiles).
3. **`?compress` on a stream** becomes a factor run (offset grids, settle and Extract on the factors) instead of plain
   tiles with the back-fill. `?compress&factors=0` keeps the old plain-tile run with the back-fill.
4. **`?compress&review` turns the stream default off** (proposed): the history review reads plain tiles only, and an
   explicit `?review` asks for it. Such a stream runs as today (plain tiles, review, back-fill, no settle). An
   explicit `?factors` with `?review` still wins over the review (console warning, as today). What would change it:
   the owner prefers the factor default over the review; then `?review` on a stream only warns.
5. **Every stream export becomes format 7** with `traces_live` (the live traces) beside Extract's `traces` and
   `traces_signed`, the stage records' `settle_source` and `source`, and the note. Recording exports stay format 6.
   A stream whose factors became unusable exports as before (format 6, live traces as `traces`).
6. **Every stream writes its factors to OPFS:** about 55 MB per 1,000 frames at 600x600 (about 2 GB for 30 min at
   20 fps). There is no quota or free-space check: a failed write marks the factors unusable and the stream ends at
   Discover's library (as `?factors` today). The folder is swept at the next run. A free-space check before the run
   (`navigator.storage.estimate()`, warn or fall back to `?factors=0`) is a separate follow-up, not this slice.
7. **The compress worker exists on every page** unless `?factors=0` (one more worker, idle on a recording that does
   not compress). The Run panel's compression readout shows only on runs that compress.
8. **Stream speed** is as measured in slice 2 (`2026-11-23-factors-live-speed.md`): the settle and Extract add time
   after the stream ends. No new measurement in this slice.

## Global Constraints

- Testing scope (owner, 23 Nov): unit tests only for logic that changes a run or an export (`factorsFromPage`,
  `factorRunPlan`); the e2e for the stream default and the off switch. The export version logic is unchanged (it
  follows the fields), so no new export test.
- A recording without a switch runs exactly as before: no compression, the same export (format 6). Pinned: Task 1's
  tests and `e2e/cala.spec.ts` unchanged.
- App checks, from the repository root: `npm run typecheck`, `npm run lint`, `npm run test -w apps/cala`, `npx prettier
--check` on every touched file.
- e2e: `npm run build:e2e`, then `npx playwright test e2e/cala-live.spec.ts e2e/cala.spec.ts e2e/cala-factors.spec.ts`.
- Commits: one sentence, conventional prefix, no body, no attribution. Never amend. Do not push.
- No machine paths, user names or emails in committed files.
- Branch: `feat/cala-factors-default`.

## Review Focus

1. **A recording without a switch does not compress.** The pipeline store's `compress` input to `factorRunPlan` is
   whether `?compress` was asked (`setCompressAsked`), not whether a compress store exists.
2. **`?factors=0` is today's stream**: no compress worker without `?compress`, no factor wait, format 6.
3. **The review decision** (decision 4) is in one place, `factorsFromPage`.

## File Structure

| File                                         | Change | Responsibility                                                   |
| -------------------------------------------- | ------ | ---------------------------------------------------------------- |
| `apps/cala/src/lib/factor-run.ts`            | modify | `factorsFromPage`, `factorRunPlan`'s `factorsDefault`, the texts |
| `apps/cala/src/__tests__/factor-run.test.ts` | modify | the switch table                                                 |
| `apps/cala/src/lib/pipeline-store.ts`        | modify | `setFactorsDefault`, `setCompressAsked`, `compressRun`           |
| `apps/cala/src/App.tsx`                      | modify | read the page once; compress worker unless `?factors=0`          |
| `apps/cala/src/components/RunPanel.tsx`      | modify | compression readout on compressing runs only                     |
| `e2e/cala-live.spec.ts`                      | modify | the default stream, `?factors=0` for the plain-stream tests      |
| docs and changelog                           | modify | `stages.md`, `README.md`, `USER_GUIDE.md`, `docs/CHANGELOG.md`   |

### Task 1: The stream default and the off switch

**Files:** `lib/factor-run.ts`, `__tests__/factor-run.test.ts`, `lib/pipeline-store.ts`, `App.tsx`,
`components/RunPanel.tsx`.

**Interfaces:**

- `function factorsFromPage(p: URLSearchParams): PageFactors` with
  `PageFactors { factors: boolean; factorsFile: boolean; factorsDefault: boolean; compressAsked: boolean; compressWorker: boolean; review: boolean; warn: string | null }`
- `factorRunPlan({ ..., factorsDefault?: boolean })`: a live stream with Discover and `factorsDefault` is a factor run.
- `pipeline.setFactorsDefault(on)`, `pipeline.setCompressAsked(on)`, `pipeline.compressRun(): boolean`.

- [ ] **Step 1: Failing tests** (`factor-run.test.ts`):
  - no switch: `factorsDefault`, compress worker, no review; a stream plan is `offset` + `factorSettle`; a recording
    plan is `compress: null`.
  - `?factors=0`: no default, no compress worker; a stream plan is `compress: null`; with `?compress` it is `plain`.
  - `?compress&review`: no default, review on; a stream plan is `plain`.
  - `?factors&review`: review off, `warn` is `FACTORS_REVIEW_OFF`.
  - `?compress` alone on a stream: `offset` + `factorSettle`; on a recording `plain`.
  - `?factors=file`: unchanged (stream: factor settle; recording: factor file run).
- [ ] **Step 2: Run them; expect failures** (no `factorsFromPage`, no `factorsDefault`).
- [ ] **Step 3: Implement** `factorsFromPage` and `factorsDefault`; the pipeline store takes `compressAsked` (default:
      a compress store was given, so its existing tests keep their meaning) and sets `compressRun`; `App.tsx` reads
      the page once; `RunPanel` gets `compress` only when `pipeline.compressRun()`. Texts: `FACTORS_LIVE_NOTE` no
      longer says "With ?factors".
- [ ] **Step 4: Checks** (`typecheck`, `lint`, `test -w apps/cala`).
- [ ] **Step 5: Commit** `feat(cala): a live stream settles and extracts on its factors by default; ?factors=0 turns it off`

### Task 2: e2e

**Files:** `e2e/cala-live.spec.ts`.

- [ ] The factor stream test runs without a switch (the default) and keeps its expectations (format 7,
      `traces_live`, settle and Extract on factors).
- [ ] The plain-stream tests (to the end; stop and restart) run with `factors=0` and keep their expectations ("Live
      run ended": the stream ends at Discover's library, no Extract).
- [ ] Run `npm run build:e2e`, then the three spec files.
- [ ] **Commit** `test(cala): e2e for the stream factor default and ?factors=0`

### Task 3: Docs and changelog

**Files:** `apps/cala/docs/stages.md`, `apps/cala/README.md`, `apps/cala/USER_GUIDE.md`, `docs/CHANGELOG.md`.

- [ ] Say decisions 1-7 where each doc speaks of `?factors`: the default, the off switch, `?compress` and
      `?compress&review` on a stream, format 7 for every stream export, the OPFS storage and its failure, recordings
      unchanged.
- [ ] Changelog under Unreleased → Changed.
- [ ] `npx prettier --write` on the touched files.
- [ ] **Commit** `docs(cala): a live stream's factor default and ?factors=0`

## Not in this slice

- A free-space or quota check before a stream (follow-up, decision 6).
- Recordings on factors by default (needs parallel compression; owner, 23 Nov).
