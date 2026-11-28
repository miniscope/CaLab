import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClickCounter,
  createDelight,
  createSequenceDetector,
  crossMilestones,
  FUN_KEY,
  HIDDEN_THEMES,
  isTypingTarget,
  KONAMI,
  milestoneNote,
  readUnlocked,
  UNLOCKED_KEY,
} from '../lib/delight.ts';
import { emptyActivity, finiteMax, stepActivity, WARMUP_TICKS } from '../lib/activity.ts';
import { panOf, pitchHz } from '../lib/choir.ts';
import { easeOut, tweenAt, TWEEN_MS } from '../lib/tween.ts';

function mockReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduced-motion') ? reduce : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-fun');
});
afterEach(() => vi.unstubAllGlobals());

describe('milestones', () => {
  it('fires 1, 100 and 500 once each as the count crosses them', () => {
    const fired = new Set<number>();
    expect(crossMilestones(0, 0, fired)).toEqual([]);
    expect(crossMilestones(0, 1, fired)).toEqual([1]);
    expect(crossMilestones(1, 50, fired)).toEqual([]);
    expect(crossMilestones(50, 120, fired)).toEqual([100]);
    // A dip and a recovery does not fire 100 again.
    expect(crossMilestones(120, 95, fired)).toEqual([]);
    expect(crossMilestones(95, 130, fired)).toEqual([]);
    expect(crossMilestones(130, 501, fired)).toEqual([500]);
    expect(crossMilestones(501, 9000, fired)).toEqual([]);
  });

  it('several crossed in one 2 Hz step come highest last (the one shown)', () => {
    const fired = new Set<number>();
    expect(crossMilestones(0, 140, fired)).toEqual([1, 100]);
    expect(fired).toEqual(new Set([1, 100]));
  });

  it('a primed count above a milestone never fires it (remount mid-run)', () => {
    const fired = new Set<number>();
    expect(crossMilestones(380, 390, fired)).toEqual([]);
  });

  it('has a short note per milestone', () => {
    expect(milestoneNote(1)).toBe('First cell!');
    expect(milestoneNote(100)).toMatch(/100/);
    expect(milestoneNote(500)).toMatch(/500/);
  });
});

describe('Easter-egg detection', () => {
  it('the Konami code completes on its last key, letters in either case', () => {
    const feed = createSequenceDetector();
    const keys = [...KONAMI.slice(0, -2), 'B', 'A'];
    expect(keys.map(feed)).toEqual([...Array(keys.length - 1).fill(false), true]);
  });

  it('a wrong key restarts the sequence; a repeated first key keeps the restart', () => {
    const feed = createSequenceDetector();
    for (const k of ['ArrowUp', 'ArrowUp', 'ArrowLeft']) expect(feed(k)).toBe(false);
    // ArrowUp ArrowUp ArrowUp ...: the code may start at the second or third press.
    const rest = ['ArrowUp', 'ArrowUp', 'ArrowUp', ...KONAMI.slice(2)];
    expect(rest.map(feed).at(-1)).toBe(true);
  });

  it('seven quick clicks on the mark trigger; a pause resets the count', () => {
    const click = createClickCounter(7, 600);
    let t = 0;
    for (let i = 0; i < 6; i++) expect(click((t += 200))).toBe(false);
    t += 2000;
    for (let i = 0; i < 6; i++) expect(click((t += 200))).toBe(false);
    expect(click((t += 200))).toBe(true);
    // Counting starts over after a trigger.
    expect(click(t + 200)).toBe(false);
  });

  it('keys typed into a field never count', () => {
    const input = document.createElement('input');
    const select = document.createElement('select');
    const div = document.createElement('div');
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(select)).toBe(true);
    expect(isTypingTarget(div)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('the Fun touches switch', () => {
  it('defaults on and stores off in localStorage, marking the root', () => {
    mockReducedMotion(false);
    const d = createDelight(HIDDEN_THEMES);
    expect(d.on()).toBe(true);
    expect(d.motion()).toBe(true);
    expect(document.documentElement.hasAttribute('data-fun')).toBe(false);
    d.setOn(false);
    expect(localStorage.getItem(FUN_KEY)).toBe('off');
    expect(document.documentElement.getAttribute('data-fun')).toBe('off');
    expect(d.motion()).toBe(false);
    // A new page reads the stored choice.
    expect(createDelight(HIDDEN_THEMES).on()).toBe(false);
    d.setOn(true);
    expect(localStorage.getItem(FUN_KEY)).toBeNull();
  });

  it('off stops the choir and runs the off listeners; the choir cannot start while off', () => {
    mockReducedMotion(false);
    const d = createDelight(HIDDEN_THEMES);
    const left = vi.fn();
    d.onOff(left);
    d.setChoir(true);
    expect(d.choir()).toBe(true);
    d.setOn(false);
    expect(d.choir()).toBe(false);
    expect(left).toHaveBeenCalledOnce();
    d.setChoir(true);
    expect(d.choir()).toBe(false);
  });

  it('survives blocked storage (on, and the switch still works for the page)', () => {
    mockReducedMotion(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const d = createDelight(HIDDEN_THEMES);
    expect(d.on()).toBe(true);
    d.setOn(false);
    expect(d.on()).toBe(false);
    expect(readUnlocked(HIDDEN_THEMES)).toEqual([]);
    vi.restoreAllMocks();
  });

  it('reduced motion keeps the moments but turns motion off', () => {
    mockReducedMotion(true);
    const d = createDelight(HIDDEN_THEMES);
    expect(d.on()).toBe(true);
    expect(d.reducedMotion()).toBe(true);
    expect(d.motion()).toBe(false);
  });

  it('unlocks hidden themes once and remembers only known names', () => {
    mockReducedMotion(false);
    const d = createDelight(HIDDEN_THEMES);
    expect(d.unlocked()).toEqual([]);
    d.unlock(['synthwave', 'notebook', 'bogus']);
    expect(d.unlocked()).toEqual(['synthwave', 'notebook']);
    expect(JSON.parse(localStorage.getItem(UNLOCKED_KEY)!)).toEqual(['synthwave', 'notebook']);
    localStorage.setItem(UNLOCKED_KEY, '{not json');
    expect(readUnlocked(HIDDEN_THEMES)).toEqual([]);
  });
});

describe('live activity', () => {
  it('a cell fires when its window maximum jumps above half its range, then fades', () => {
    const st = emptyActivity();
    const quiet = () => 1;
    for (let i = 0; i <= WARMUP_TICKS; i++) expect(stepActivity(st, [7], quiet)).toEqual([]);
    // A transient: fires once, glows fully.
    expect(stepActivity(st, [7], () => 5)).toEqual([7]);
    expect(st.get(7)!.glow).toBe(1);
    expect(stepActivity(st, [7], () => 5)).toEqual([]);
    // Back to baseline: the glow decays over the next ticks.
    stepActivity(st, [7], quiet);
    const g1 = st.get(7)!.glow;
    stepActivity(st, [7], quiet);
    expect(st.get(7)!.glow).toBeLessThan(g1);
    expect(g1).toBeLessThan(1);
  });

  it('never fires during warm-up and drops cells that left the library', () => {
    const st = emptyActivity();
    expect(stepActivity(st, [1, 2], (id) => id)).toEqual([]);
    expect(stepActivity(st, [1, 2], (id) => 100 * id)).toEqual([]);
    stepActivity(st, [2], () => 3);
    expect([...st.keys()]).toEqual([2]);
  });

  it('skips non-finite samples', () => {
    expect(finiteMax([NaN, 2, Infinity, 5, NaN])).toBe(5);
    expect(Number.isNaN(finiteMax([NaN]))).toBe(true);
  });
});

describe('choir mapping', () => {
  it('higher in the field sings higher, on a pentatonic scale from A2', () => {
    expect(pitchHz(1)).toBeCloseTo(110);
    expect(pitchHz(0)).toBeGreaterThan(pitchHz(0.5));
    expect(pitchHz(0.5)).toBeGreaterThan(pitchHz(1));
  });

  it('pans by x, kept off the hard edges', () => {
    expect(panOf(0)).toBeCloseTo(-0.8);
    expect(panOf(0.5)).toBeCloseTo(0);
    expect(panOf(1)).toBeCloseTo(0.8);
  });
});

describe('count tween', () => {
  it('eases out to the exact target', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(tweenAt(10, 110, 0, 0)).toBe(10);
    expect(tweenAt(10, 110, 0, TWEEN_MS)).toBe(110);
    expect(tweenAt(10, 110, 0, TWEEN_MS / 2)).toBeGreaterThan(60);
  });
});
