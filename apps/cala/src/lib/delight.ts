/**
 * Fun touches: the small moments of the app (cell-count milestones, the finish shimmer, the
 * live pulse of the mark) and its hidden surprises, behind one switch.
 *
 * - One switch, "Fun touches", stored in localStorage (`cala-fun`), default on. Off puts
 *   `data-fun="off"` on the root element: every fun CSS rule keys on that attribute, and the JS
 *   reads `funOn()`. Off also stops the choir and drops a hidden theme back to the system one;
 *   fun colour schemes picked in the overlay stay (they are a display choice the user made).
 * - Reduced motion (`prefers-reduced-motion: reduce`) keeps the moments but without motion:
 *   static equivalents (the note appears and leaves without movement, no shimmer, no pulse).
 * - Nothing here touches the data or the pipeline. Everything live is fed from the rail's
 *   2 Hz snapshot.
 *
 * The pure parts (milestones, the Konami and click-count detectors, storage) are unit-tested.
 */
import { createSignal, type Accessor } from 'solid-js';

/** localStorage key of the switch ('off' when off; absent = on). */
export const FUN_KEY = 'cala-fun';
/** localStorage key of the unlocked hidden themes (JSON array of names). */
export const UNLOCKED_KEY = 'cala-unlocked-themes';

/** Cell counts that get a moment, with their note. */
export const MILESTONES: readonly { at: number; note: string }[] = [
  { at: 1, note: 'First cell!' },
  { at: 100, note: '100 cells!' },
  { at: 500, note: '500 cells!' },
];

/**
 * Milestones crossed going from `prev` to `next` cells, not yet in `fired` (which it updates).
 * Several crossed in one step yield all of them, highest last; the caller shows only the last.
 */
export function crossMilestones(prev: number, next: number, fired: Set<number>): number[] {
  const out: number[] = [];
  for (const m of MILESTONES) {
    if (next >= m.at && prev < m.at && !fired.has(m.at)) {
      fired.add(m.at);
      out.push(m.at);
    }
  }
  return out;
}

/**
 * Milestones of one run's live cell count, read at the rail's 2 Hz: reset when a run starts,
 * nothing while idle or starting (the last run's library is still loaded then), and primed on
 * its first reading, so a remount mid-run or after it never replays a milestone. `observe`
 * returns the milestone to show (the highest one crossed), or null.
 */
export function createMilestoneTracker() {
  const fired = new Set<number>();
  let last: number | null = null;
  return {
    observe(status: string, cells: number | null): number | null {
      if (status === 'starting') {
        fired.clear();
        last = 0;
        return null;
      }
      if (cells === null || status === 'idle') return null;
      if (last === null) {
        last = cells;
        return null;
      }
      const crossed = crossMilestones(last, cells, fired);
      last = cells;
      return crossed.at(-1) ?? null;
    },
  };
}

export const milestoneNote = (at: number): string =>
  MILESTONES.find((m) => m.at === at)?.note ?? `${at.toLocaleString('en-US')} cells`;

/** The Konami code, as `KeyboardEvent.key` values (letters lower-cased). */
export const KONAMI = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'b',
  'a',
] as const;

/** Feed keys one at a time; true on the key that completes `seq` (the last keys pressed). */
export function createSequenceDetector(seq: readonly string[] = KONAMI) {
  const last: string[] = [];
  return (key: string): boolean => {
    last.push(key.length === 1 ? key.toLowerCase() : key);
    if (last.length > seq.length) last.shift();
    if (last.length === seq.length && last.every((k, i) => k === seq[i])) {
      last.length = 0;
      return true;
    }
    return false;
  };
}

/** Feed click times (ms); true on the `n`th click with each gap under `gapMs`. */
export function createClickCounter(n = 7, gapMs = 600) {
  let count = 0;
  let last = -Infinity;
  return (t: number): boolean => {
    count = t - last <= gapMs ? count + 1 : 1;
    last = t;
    if (count >= n) {
      count = 0;
      return true;
    }
    return false;
  };
}

/** True when a key event comes from a place the user types into (never a trigger there). */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!t || typeof (t as Element).closest !== 'function') return false;
  const el = t as HTMLElement;
  if (el.isContentEditable) return true;
  return el.closest('input, textarea, select, [contenteditable]') !== null;
}

function readFun(): boolean {
  try {
    return localStorage.getItem(FUN_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeFun(on: boolean): void {
  try {
    if (on) localStorage.removeItem(FUN_KEY);
    else localStorage.setItem(FUN_KEY, 'off');
  } catch {
    /* storage blocked: the switch holds for this page only */
  }
}

/** Hidden themes this browser unlocked (only known names). */
export function readUnlocked(known: readonly string[]): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(UNLOCKED_KEY) ?? '[]');
    return Array.isArray(v) ? known.filter((k) => v.includes(k)) : [];
  } catch {
    return [];
  }
}

function writeUnlocked(names: readonly string[]): void {
  try {
    localStorage.setItem(UNLOCKED_KEY, JSON.stringify(names));
  } catch {
    /* storage blocked: unlocked for this page only */
  }
}

function reducedMotionQuery(): MediaQueryList | null {
  return typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
}

/** The fun state of the page (one per page; `delight` below). */
export function createDelight(hidden: readonly string[]) {
  const initial = readFun();
  const [on, setOnSig] = createSignal(initial);
  const mq = reducedMotionQuery();
  const [reduced, setReduced] = createSignal(mq?.matches ?? false);
  mq?.addEventListener?.('change', (e) => setReduced(e.matches));
  const [unlocked, setUnlocked] = createSignal<string[]>(readUnlocked(hidden));
  const [choir, setChoir] = createSignal(false);
  const offListeners: (() => void)[] = [];

  const mark = (v: boolean) => {
    if (typeof document === 'undefined') return;
    if (v) document.documentElement.removeAttribute('data-fun');
    else document.documentElement.setAttribute('data-fun', 'off');
  };
  mark(initial);

  return {
    /** Fun touches on. */
    on: on as Accessor<boolean>,
    setOn(v: boolean) {
      setOnSig(v);
      writeFun(v);
      mark(v);
      if (!v) {
        setChoir(false);
        for (const f of offListeners) f();
      }
    },
    /** `prefers-reduced-motion: reduce`: moments without motion. */
    reducedMotion: reduced as Accessor<boolean>,
    /** Motion allowed: fun on and no reduced-motion preference. */
    motion: () => on() && !reduced(),
    unlocked: unlocked as Accessor<string[]>,
    unlock(names: readonly string[]) {
      const next = hidden.filter((h) => unlocked().includes(h) || names.includes(h));
      setUnlocked(next);
      writeUnlocked(next);
    },
    choir: choir as Accessor<boolean>,
    setChoir: (v: boolean) => setChoir(v && on()),
    /** Called when the switch turns off (e.g. leave a hidden theme). */
    onOff: (f: () => void) => offListeners.push(f),
  };
}

export type Delight = ReturnType<typeof createDelight>;

/** Hidden themes (token sets in `@calab/ui` tokens.css), unlocked by the logo. */
export const HIDDEN_THEMES = ['synthwave', 'notebook'] as const;

let page: Delight | null = null;
/** The page's fun state, created on first use. */
export function delight(): Delight {
  page ??= createDelight(HIDDEN_THEMES);
  return page;
}

/** Tests: forget the page state. */
export function resetDelightForTests(): void {
  page = null;
}
