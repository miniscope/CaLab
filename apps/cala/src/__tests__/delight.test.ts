import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClickCounter,
  createDelight,
  createMilestoneTracker,
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
import { emptyActivity, finiteMax, seedOf, stepActivity } from '../lib/activity.ts';
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
  it('fires each once as the count crosses it', () => {
    const fired = new Set<number>();
    expect(crossMilestones(0, 0, fired)).toEqual([]);
    expect(crossMilestones(0, 1, fired)).toEqual([1]);
    expect(crossMilestones(1, 49, fired)).toEqual([]);
    expect(crossMilestones(49, 120, fired)).toEqual([50, 100]);
    // A dip and a recovery does not fire 100 again.
    expect(crossMilestones(120, 95, fired)).toEqual([]);
    expect(crossMilestones(95, 130, fired)).toEqual([]);
    expect(crossMilestones(130, 501, fired)).toEqual([250, 500]);
    expect(crossMilestones(501, 9000, fired)).toEqual([1000]);
    expect(crossMilestones(9000, 9500, fired)).toEqual([]);
  });

  it('several crossed in one 2 Hz step come highest last (the one shown)', () => {
    const fired = new Set<number>();
    expect(crossMilestones(0, 140, fired)).toEqual([1, 50, 100]);
    expect(fired).toEqual(new Set([1, 50, 100]));
  });

  it('a primed count above a milestone never fires it (remount mid-run)', () => {
    const fired = new Set<number>();
    expect(crossMilestones(380, 390, fired)).toEqual([]);
  });

  it('has a short note per milestone', () => {
    expect(milestoneNote(1)).toBe('First cell!');
    expect(milestoneNote(100)).toBe('100 cells!');
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
  /** A deterministic jittered baseline: level 10, noise of sd about 1. */
  const jitter = (i: number) => 10 + Math.sin(i * 12.9898) * 1.7;
  const history = (n: number) => Array.from({ length: n }, (_, i) => jitter(i));

  it('reads baseline and noise from recent history', () => {
    const sd = seedOf(history(1000))!;
    expect(sd.base).toBeGreaterThan(9);
    expect(sd.base).toBeLessThan(11);
    expect(sd.noise).toBeGreaterThan(0.3);
    expect(sd.noise).toBeLessThan(3);
    expect(seedOf([1, 2, NaN])).toBeNull();
  });

  it('a noisy baseline never fires and stays dark', () => {
    const st = emptyActivity();
    const seed = () => seedOf(history(1000));
    for (let t = 0; t < 60; t++) {
      // The largest of ~150 noisy frames since the last tick.
      const w = finiteMax(Array.from({ length: 150 }, (_, i) => jitter(t * 150 + i)));
      expect(stepActivity(st, [7], () => w, seed)).toEqual([]);
    }
    expect(st.get(7)!.glow).toBe(0);
  });

  it('a transient fires once, glows fully, then fades', () => {
    const st = emptyActivity();
    const seed = () => seedOf(history(1000));
    stepActivity(st, [7], () => 12, seed);
    expect(stepActivity(st, [7], () => 40, seed)).toEqual([7]);
    expect(st.get(7)!.glow).toBe(1);
    expect(stepActivity(st, [7], () => 40, seed)).toEqual([]);
    stepActivity(st, [7], () => 12, seed);
    const g1 = st.get(7)!.glow;
    stepActivity(st, [7], () => 12, seed);
    expect(st.get(7)!.glow).toBeLessThan(g1);
    expect(g1).toBeLessThan(1);
  });

  it('skips a cell without history and drops cells that left the library', () => {
    const st = emptyActivity();
    expect(
      stepActivity(
        st,
        [1, 2],
        () => 5,
        (id) => (id === 2 ? seedOf(history(50)) : null),
      ),
    ).toEqual([]);
    expect([...st.keys()]).toEqual([2]);
    stepActivity(st, [], () => 3);
    expect(st.size).toBe(0);
  });

  it('skips non-finite samples', () => {
    expect(finiteMax([NaN, 2, Infinity, 5, NaN])).toBe(5);
    expect(Number.isNaN(finiteMax([NaN]))).toBe(true);
  });
});

describe('milestone tracker (the rail)', () => {
  it('fires on a fresh run, resets on the next run', () => {
    const m = createMilestoneTracker();
    expect(m.observe('idle', null, -1)).toBeNull();
    expect(m.observe('starting', 380, -1)).toBeNull();
    expect(m.observe('running', 0, 1)).toBeNull();
    expect(m.observe('running', 3, 1)).toBe(1);
    expect(m.observe('running', 150, 1)).toBe(100);
    expect(m.observe('done', 402, 1)).toBe(250);
    // A rerun: the last library is still loaded while starting; milestones fire again after.
    expect(m.observe('starting', 402, 1)).toBeNull();
    expect(m.observe('running', 1, 2)).toBe(1);
  });

  it('fires without ever seeing the starting status (a new run key is enough)', () => {
    const m = createMilestoneTracker();
    expect(m.observe('running', 0, 3)).toBeNull();
    expect(m.observe('running', 20, 3)).toBe(1);
    expect(m.observe('done', 401, 3)).toBe(250);
    // The next run, its 'starting' missed between two readings, already has cells.
    expect(m.observe('running', 60, 4)).toBe(50);
  });

  it('a rail mounted mid-run (or after it) is primed, never replays', () => {
    const m = createMilestoneTracker();
    expect(m.observe('running', 380, 5)).toBeNull();
    expect(m.observe('running', 520, 5)).toBe(500);
    const after = createMilestoneTracker();
    expect(after.observe('done', 402, 5)).toBeNull();
    expect(after.observe('done', 402, 5)).toBeNull();
  });

  it('a saved result never fires', () => {
    const m = createMilestoneTracker();
    expect(m.observe('idle', 300, -2)).toBeNull();
    expect(m.observe('done', 300, -2)).toBeNull();
  });

  it('shows the highest when several are crossed between two readings', () => {
    const m = createMilestoneTracker();
    m.observe('starting', null, -1);
    expect(m.observe('running', 140, 6)).toBe(100);
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
