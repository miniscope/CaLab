/**
 * Shared fakes for `SlowRunner` tests: a one-cell published library, the
 * slow worker's `init` message, and an inert `SlowLoopLike` that a test
 * overrides with the members it exercises.
 */
import { vi } from 'vitest';
import type { PublishedLibrary, SlowLoopLike } from '../lib/slow-runner.ts';
import type { FastToSlow } from '../workers/slow-types.ts';
import { DEFAULT_PARAMS } from './params-fixtures.ts';

/** A published library of one cell (id 1, one pixel); `toBytes` is `[version]`. */
export function fakeLib(version: number): PublishedLibrary {
  return {
    version,
    ids: () => Uint32Array.of(1),
    centers: () => Float32Array.of(0, 0),
    radii: () => Float32Array.of(1),
    supportStarts: () => Uint32Array.of(0, 1),
    supportPixels: () => Uint32Array.of(0),
    footprintValues: () => Float32Array.of(1),
    toBytes: () => Uint8Array.of(version),
    free: vi.fn(),
  };
}

/** An `init` for a 2 x 1 frame, session 1, budget 123, look-back off. */
export const INIT: Extract<FastToSlow, { type: 'init' }> = {
  type: 'init',
  session: 1,
  width: 2,
  height: 1,
  fov: Uint8Array.of(1, 1),
  noise: Float32Array.of(1, 1),
  params: DEFAULT_PARAMS,
  budget: 123,
};

/**
 * A `SlowLoopLike` that does nothing unless told: every method is a `vi.fn`
 * spy; `observe` keeps every frame, `step`, `housekeep`, `takeJob` and
 * `publishedLibrary` return nothing, `finalize` returns `fakeLib(1)`, and the
 * look-back, settle and statistics getters return empty arrays (`stats`: 17
 * zeros). `over` replaces members as given.
 */
export function stubSlowLoop(over: Partial<SlowLoopLike> = {}): SlowLoopLike {
  return {
    stageTiming: vi.fn(() => new Float64Array(0)),
    observe: vi.fn(() => true),
    step: vi.fn(() => undefined),
    finalize: vi.fn(() => fakeLib(1)),
    setNoise: vi.fn(),
    setEditScope: vi.fn(),
    setVisitSchedule: vi.fn(),
    visitSchedule: vi.fn(() => new Float64Array(0)),
    visitRateStats: vi.fn(() => new Float64Array(0)),
    takeJob: vi.fn(() => undefined),
    applyJob: vi.fn(),
    housekeep: vi.fn(() => undefined),
    publishedLibrary: vi.fn(() => undefined),
    addReviewed: vi.fn(() => 0),
    cellCount: 0,
    reservoirBytes: 0,
    framesPerTile: 0,
    reservoirWarning: undefined,
    work: 0,
    stats: vi.fn(() => new Float64Array(17)),
    cellStatus: vi.fn(() => new Float64Array(0)),
    lookbackNote: vi.fn(),
    setLookbackFloor: vi.fn(),
    lookbackTake: vi.fn(() => new Float64Array(0)),
    observeLookback: vi.fn(() => true),
    markAllDue: vi.fn(),
    lookbackStats: vi.fn(() => new Float64Array(0)),
    footprintNoise: vi.fn(() => new Float64Array(0)),
    footprintNoiseOn: vi.fn(() => 0),
    enableSettle: vi.fn(),
    settleTake: vi.fn(() => new Float64Array(0)),
    observeSettle: vi.fn(() => true),
    settleSkipped: vi.fn(),
    settleStats: vi.fn(() => new Float64Array(0)),
    free: vi.fn(),
    ...over,
  };
}
