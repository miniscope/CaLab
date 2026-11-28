import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schemaDefaults, CALA_PARAMS_VERSION } from '../schema.ts';
import { LOOKBACK, FACTOR_SETTLE } from '../../lib/slow-runner.ts';
import { SETTLE, CSETTLE, FINAL_SETTLE_LEVEL_DEFAULT } from '../../lib/settle.ts';
import { VISIT_RATE } from '../../lib/visit-rate.ts';
import { FAST_LOOP_DEFAULTS } from '../../lib/fast-loop.ts';
import { COMPRESS_DEFAULTS } from '../../lib/compress-feed.ts';
import { PIPELINE_DEFAULTS } from '../../lib/pipeline-plan.ts';
import { FLAT_FIELD_FIRST_S, FLAT_FIELD_REFINE_S } from '../../lib/flat-field.ts';
import { MIN_SNR, PAIR_R, MOTION_R2_FLAG } from '../../lib/qc.ts';
import { SPEED_DEFAULTS, CAP_CHOICES, CURVE_PRESET_IDS } from '../../lib/speed-track.ts';
import { ASSUMED_FPS } from '../../lib/miniscope-meta.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));

/** The default params resolved at 20 fps (crates/cala/tests/golden). */
interface EngineView20 {
  preprocess: { warmup_frames: number };
  motion: { warmup_frames: number };
  lookback: { max_frames: number };
  settle: { final_max_frames: number };
  factors: { window_frames: number };
  slow_loop: { merge_guard_min_sep: number | null };
}

describe('cala params drift', () => {
  it('the checked-in .d.ts is what the generator writes from the schema', () => {
    const script = join(repoRoot, 'apps/cala/scripts/gen-params-dts.mjs');
    const fresh = execFileSync(process.execPath, [script, '--stdout'], { encoding: 'utf8' });
    const checkedIn = readFileSync(join(repoRoot, 'apps/cala/src/params/cala-params.d.ts'), 'utf8');
    expect(checkedIn, 'stale: run `npm run gen:params`').toBe(fresh);
  });

  it('the schema is params version 1', () => {
    expect(CALA_PARAMS_VERSION).toBe(1);
  });

  it('the schema defaults are the values the app ships', () => {
    const p = schemaDefaults();
    // Look-back's slow-loop options and rate.
    expect(p.lookback.enabled).toBe(true);
    expect(p.lookback.rate).toBe(LOOKBACK.rate);
    expect(p.discover.cluster.update).toBe(LOOKBACK.jointUpdate);
    expect(p.discover.cluster.sign).toBe(LOOKBACK.jointSign);
    expect(p.discover.merge.guard_min_sep_d).toBe(LOOKBACK.mergeGuardMinSep);
    // The Final settle on factors.
    expect(p.settle.on_factors.cluster_update).toBe(FACTOR_SETTLE.jointUpdate);
    expect(FACTOR_SETTLE.mergeGuardMinSep).toBe(Infinity);
    expect(p.settle.on_factors.guard_min_sep_d).toBeNull();
    // Settle.
    expect(p.settle.background.cap).toBe(CSETTLE.rate);
    expect(p.settle.background.cap).toBe(SPEED_DEFAULTS.cap);
    expect([...CAP_CHOICES].sort()).toEqual([0, 0.5, 1, 2]);
    expect(p.settle.final.level).toBe(FINAL_SETTLE_LEVEL_DEFAULT);
    // Discover.
    expect(p.discover.visit.target).toBe(VISIT_RATE.target);
    expect(p.discover.visit.mode).toBe('fixed');
    expect(p.discover.budget).toBe(FAST_LOOP_DEFAULTS.budget);
    // Pipeline.
    expect(p.compute.batch_frames).toBe(PIPELINE_DEFAULTS.batchSize);
    expect(p.flat_field.enabled).toBe(PIPELINE_DEFAULTS.flatField);
    expect(p.motion.session_fix).toBe(PIPELINE_DEFAULTS.sessionFix);
    expect(p.flat_field.first_map_s).toBe(FLAT_FIELD_FIRST_S);
    expect(p.flat_field.refine_every_s).toBe(FLAT_FIELD_REFINE_S);
    // QC pass rule.
    expect(p.qc.pass.min_snr).toBe(MIN_SNR);
    expect(p.qc.pass.pair_r).toBe(PAIR_R);
    expect(p.qc.pass.motion_r2_flag).toBe(MOTION_R2_FLAG);
    // Speed.
    expect(p.compute.speed.mode).toBe(SPEED_DEFAULTS.mode);
    expect(p.compute.speed.fps).toBe(SPEED_DEFAULTS.fixedFps);
    expect(p.compute.speed.curve).toBe(SPEED_DEFAULTS.preset);
    expect(CURVE_PRESET_IDS).toContain(p.compute.speed.curve);
    expect(p.compute.speed.auto_budget).toBe(SPEED_DEFAULTS.autoBudget);
    // Durations counted in fixed frames convert at the app's fallback rate.
    expect(p.time.legacy_frame_fps).toBe(ASSUMED_FPS);
    // The cell diameter: 10 px set directly, no optics.
    expect(p.scales.cell_diameter_px).toBe(10);
    expect(p.scales.expected_cell_diameter_um).toBeNull();
  });

  it('the frame counts the app ships equal the resolved defaults at 20 fps', () => {
    const v = readJson('crates/cala/tests/golden/engine-view-fps20.json') as EngineView20;
    expect(v.preprocess.warmup_frames).toBe(PIPELINE_DEFAULTS.calibrationFrames);
    expect(v.motion.warmup_frames).toBe(PIPELINE_DEFAULTS.motionWarmupFrames);
    expect(v.lookback.max_frames).toBe(LOOKBACK.maxFrames);
    expect(v.settle.final_max_frames).toBe(SETTLE.maxFrames);
    expect(v.factors.window_frames).toBe(COMPRESS_DEFAULTS.window);
    expect(v.slow_loop.merge_guard_min_sep).toBe(LOOKBACK.mergeGuardMinSep);
  });
});
