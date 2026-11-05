import { describe, it, expect } from 'vitest';
import {
  buildSimulationConfig,
  DEFAULT_QUALITATIVE_CONFIG,
  NOISE_LEVELS,
} from '../simulation-quality-presets.ts';

describe('buildSimulationConfig noise spread', () => {
  it('gives the default (demo) dataset a per-cell SNR spread around the unchanged level', () => {
    const cfg = buildSimulationConfig(DEFAULT_QUALITATIVE_CONFIG);
    expect(cfg.noise.snr).toBe(60);
    // Cells draw uniformly in [snr - spread, snr + spread]: 30..90 here.
    expect(cfg.noise.snr_spread).toBe(30);
  });

  it('keeps the clean level exact', () => {
    const cfg = buildSimulationConfig({ ...DEFAULT_QUALITATIVE_CONFIG, noise: [0, 0] });
    expect(cfg.noise.snr).toBe(200);
    expect(cfg.noise.snr_spread).toBe(0);
  });

  it('never narrows the spread a chosen range of levels implies', () => {
    // Levels 1..3 span SNR 60..15: midpoint 37.5, range half-width 22.5.
    const cfg = buildSimulationConfig({ ...DEFAULT_QUALITATIVE_CONFIG, noise: [1, 3] });
    expect(cfg.noise.snr).toBeCloseTo(37.5);
    expect(cfg.noise.snr_spread).toBeGreaterThanOrEqual(22.5);
  });

  it('every non-clean level has a positive spread that keeps cells above SNR 1', () => {
    for (const level of NOISE_LEVELS) {
      if (level.id === 'clean') continue;
      expect(level.snr_spread_fraction).toBeGreaterThan(0);
      expect(level.snr_spread_fraction).toBeLessThan(1);
    }
  });
});
