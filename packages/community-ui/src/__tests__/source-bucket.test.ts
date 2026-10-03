import { describe, it, expect } from 'vitest';
import { matchesSourceBucket, matchesDemoPreset } from '../source-bucket.ts';

describe('matchesSourceBucket', () => {
  // Regression: the browser source toggle only ever selects 'demo' or 'user'.
  // Submissions are stored with their exact source, so bridge/training rows
  // (e.g. real data loaded via the Python calab.tune bridge) were silently
  // filtered out of the 'user' bucket and never appeared in the community
  // browser. The 'user' bucket must include every non-demo source.

  it('matches user submissions to the user bucket', () => {
    expect(matchesSourceBucket('user', 'user')).toBe(true);
  });

  it('matches bridge submissions to the user bucket', () => {
    expect(matchesSourceBucket('bridge', 'user')).toBe(true);
  });

  it('matches training submissions to the user bucket', () => {
    expect(matchesSourceBucket('training', 'user')).toBe(true);
  });

  it('matches demo submissions to the demo bucket', () => {
    expect(matchesSourceBucket('demo', 'demo')).toBe(true);
  });

  it('does not show demo submissions in the user bucket', () => {
    expect(matchesSourceBucket('demo', 'user')).toBe(false);
  });

  it('does not show non-demo submissions in the demo bucket', () => {
    expect(matchesSourceBucket('user', 'demo')).toBe(false);
    expect(matchesSourceBucket('bridge', 'demo')).toBe(false);
    expect(matchesSourceBucket('training', 'demo')).toBe(false);
  });
});

describe('matchesDemoPreset', () => {
  // Regression: demo submissions record the simulated indicator id in
  // extra_metadata. A refactor removed that write while leaving the filter in
  // place, so selecting any indicator matched nothing at all.
  const demoRow = (preset?: string) => ({
    data_source: 'demo' as const,
    extra_metadata: preset ? { demo_preset: preset } : {},
  });

  it('passes every row when nothing is selected', () => {
    expect(matchesDemoPreset(demoRow('gcamp6f'), null)).toBe(true);
    expect(matchesDemoPreset({ data_source: 'user', extra_metadata: undefined }, null)).toBe(true);
  });

  it('matches a demo row recorded under the selected indicator', () => {
    expect(matchesDemoPreset(demoRow('gcamp6f'), 'gcamp6f')).toBe(true);
  });

  it('rejects a demo row recorded under a different indicator', () => {
    expect(matchesDemoPreset(demoRow('gcamp6s'), 'gcamp6f')).toBe(false);
  });

  it('rejects demo rows with no recorded indicator', () => {
    expect(matchesDemoPreset(demoRow(), 'gcamp6f')).toBe(false);
    expect(matchesDemoPreset({ data_source: 'demo', extra_metadata: undefined }, 'gcamp6f')).toBe(
      false,
    );
  });

  it('leaves non-demo rows to the source-bucket filter', () => {
    expect(matchesDemoPreset({ data_source: 'user', extra_metadata: undefined }, 'gcamp6f')).toBe(
      true,
    );
    expect(matchesDemoPreset({ data_source: 'bridge', extra_metadata: undefined }, 'gcamp6f')).toBe(
      true,
    );
  });
});
