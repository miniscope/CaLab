/**
 * Run params for tests: the default params as the frame worker resolves them at 20 fps, built
 * from the checked-in schema and golden engine view (no WASM needed), and real resolutions of
 * other layers (suites that load the WASM module).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { schemaDefaults } from '../params/schema.ts';
import { makePlan, type PipelineOptions, type PipelinePlan } from '../lib/pipeline-plan.ts';
import { resolveRunParams } from '../lib/params-handle.ts';
import { runParams, type ParamsLayer, type RunParams } from '../lib/run-params.ts';

const GOLDEN_20 = resolve(
  import.meta.dirname,
  '../../../../crates/cala/tests/golden/engine-view-fps20.json',
);

/**
 * The default params resolved at 20 fps on a 600 x 600 frame (`ResolvedParams.toJson`'s shape,
 * without a fingerprint: `ResolvedParams.fromJson` accepts it and rebuilds the same engine).
 */
export const DEFAULT_PARAMS: string = JSON.stringify({
  params: schemaDefaults(),
  context: { fps: 20, frame: [600, 600] },
  engine: JSON.parse(readFileSync(GOLDEN_20, 'utf8')) as unknown,
});

/** `DEFAULT_PARAMS`, parsed. */
export const DEFAULT_RUN: RunParams = runParams(DEFAULT_PARAMS);

/** `layer` resolved by the WASM module for a recording at `fps` (the suite must load it). */
export function resolvedParams(layer: ParamsLayer, fps = 20, width = 64, height = 64): string {
  return resolveRunParams(layer, { fps, width, height });
}

/**
 * The engine's own configuration (`params::loose::engine_params`) at a cell diameter of `d` px:
 * look-back, the cluster replay and the merge guard off, and the slow loop's ring and tile
 * margin at 12 / 20 px and 24 px whatever `d` (the defaults follow the diameter).
 */
export function engineLayer(d: number): ParamsLayer {
  return {
    scales: { cell_diameter_px: d },
    lookback: { enabled: false },
    discover: {
      cluster: { update: 'off' },
      merge: { guard_min_sep_d: null },
      ring: { inner_per_d: 12 / d, outer_per_d: 20 / d },
      margin_px: 24,
    },
  };
}

/** A plan under the default params. */
export function testPlan(
  frameCount: number,
  options: PipelineOptions = {},
  boundaries: readonly number[] = [],
): PipelinePlan {
  return makePlan(frameCount, DEFAULT_RUN, options, boundaries);
}
