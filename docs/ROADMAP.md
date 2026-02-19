# CaTune Roadmap

## Phase 0 — Stabilize & Codify Conventions (current)

Pin toolchains, add linting/formatting, document architecture, create module boundaries with barrel files and ESLint import rules, add runtime validation schema for export format.

## Phase 1 — Core Module Extraction

Restructure `src/lib/` into `src/core/` with clean module boundaries. Extract solver, data management, and chart modules into self-contained units with explicit public APIs.

## Phase 2 — State Management Refinement

Formalize the signal-based state pattern. Add derived computations, improve reactivity granularity, and document state flow for each feature.

## Phase 3 — Testing & Quality

Expand test coverage for core modules (solver pipeline, data import/export, warm-start cache). Add integration tests for critical user flows.

## Phase 4 — Monorepo Preparation

Evaluate monorepo structure for separating solver core, UI, and community features. Prepare package boundaries for potential extraction.
