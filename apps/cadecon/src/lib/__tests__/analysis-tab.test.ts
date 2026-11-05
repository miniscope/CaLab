import { describe, it, expect } from 'vitest';
import { nextTabForRunState } from '../analysis-tab.ts';

describe('nextTabForRunState', () => {
  it('a fresh start shows Asymptote', () => {
    expect(nextTabForRunState('running', 'idle', 'results')).toBe('asymptote');
    expect(nextTabForRunState('running', 'complete', 'results')).toBe('asymptote');
    expect(nextTabForRunState('running', 'idle', 'asymptote')).toBe('asymptote');
  });

  it('resuming a paused run keeps the current tab', () => {
    expect(nextTabForRunState('running', 'paused', 'results')).toBe('results');
  });

  it('a finished or stopped run moves Asymptote to Results', () => {
    expect(nextTabForRunState('complete', 'running', 'asymptote')).toBe('results');
    expect(nextTabForRunState('complete', 'stopping', 'asymptote')).toBe('results');
  });

  it('never moves a user off the Kernel tab', () => {
    expect(nextTabForRunState('running', 'idle', 'kernel')).toBe('kernel');
    expect(nextTabForRunState('complete', 'running', 'kernel')).toBe('kernel');
  });
});
