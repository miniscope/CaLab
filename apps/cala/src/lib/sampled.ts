/**
 * A value read from reactive stores at most once per period, and at once when a key changes.
 * Live figures use it so a store that updates every batch costs one read per period, not one
 * per batch.
 */
import { createMemo, createSignal, on, onCleanup, untrack, type Accessor } from 'solid-js';

/**
 * `read()` evaluated untracked every `periodMs` and whenever `key()` changes (compared with
 * `===`). Must run inside a reactive owner (a component or root); the timer stops with it.
 */
export function createSampled<T>(read: () => T, key: () => string, periodMs: number): Accessor<T> {
  const [beat, setBeat] = createSignal(0);
  const timer = setInterval(() => setBeat((b) => b + 1), periodMs);
  onCleanup(() => clearInterval(timer));
  // A memo of the key: only a change of its value, not of what it reads, wakes the sample.
  const k = createMemo(key);
  return createMemo(on([beat, k], () => untrack(read)));
}
