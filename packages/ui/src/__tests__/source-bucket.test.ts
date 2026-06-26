import { describe, it, expect } from 'vitest';
import { matchesSourceBucket } from '../source-bucket.ts';

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
