import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schemaDefaults, CALA_PARAMS_VERSION } from '../schema.ts';
import { CSETTLE, FINAL_SETTLE_LEVEL_DEFAULT } from '../../lib/settle.ts';
import { VISIT_RATE } from '../../lib/visit-rate.ts';
import { SPEED_DEFAULTS, CAP_CHOICES, CURVE_PRESET_IDS } from '../../lib/speed-track.ts';
import { ASSUMED_FPS } from '../../lib/miniscope-meta.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');

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
    // Settle.
    expect(p.settle.background.cap).toBe(CSETTLE.rate);
    expect(p.settle.background.cap).toBe(SPEED_DEFAULTS.cap);
    expect([...CAP_CHOICES].sort()).toEqual([0, 0.5, 1, 2]);
    expect(p.settle.final.level).toBe(FINAL_SETTLE_LEVEL_DEFAULT);
    // Discover: the fixed schedule's floor and cap are 2/3 and 4/3 of its target.
    expect(p.discover.visit.mode).toBe('fixed');
    expect(VISIT_RATE.floor).toBeCloseTo((2 / 3) * p.discover.visit.target, 12);
    expect(VISIT_RATE.cap).toBeCloseTo((4 / 3) * p.discover.visit.target, 12);
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

  it('no TS copy of an engine value comes back', () => {
    // Names and literals of the copies the run's params replaced (they are read from the
    // resolved params, or from the schema where no run exists).
    const gone = [
      'PIPELINE_DEFAULTS',
      'FACTOR_SETTLE',
      'FLAT_FIELD_FIRST_S',
      'FLAT_FIELD_REFINE_S',
      'MotionOptions',
      'PreprocessConfig',
      'withConfig',
      'enableLookback',
      'cellDiameterPx',
      'flattenSigmaPx',
      'maxFrames: 18',
      'budget: 3e7',
      'window: 600',
      'mergeGuardMinSep: 0.6',
    ];
    const src = join(repoRoot, 'apps/cala/src');
    const files = (readdirSync(src, { recursive: true }) as string[]).filter(
      (f) => /\.(ts|tsx)$/.test(f) && !f.includes('__tests__'),
    );
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(src, f), 'utf8');
      for (const g of gone) if (text.includes(g)) hits.push(`${f}: ${g}`);
    }
    expect(hits).toEqual([]);
  });
});
