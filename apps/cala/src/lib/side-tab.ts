/**
 * The right-hand column's active tab, remembered per viewer (the app and the
 * saved-result viewer) in localStorage. Storage can be missing or refuse
 * (private windows, blocked site data): the tab then starts on its default.
 */
import { createEffect, createSignal, on, type Accessor } from 'solid-js';

/** The viewers that remember a tab of their own. */
export type SideTabViewer = 'run' | 'result';

export const SIDE_TAB_KEY = 'cala.sideTab';

const key = (viewer: SideTabViewer) => `${SIDE_TAB_KEY}.${viewer}`;

/** The stored tab of a viewer, or null. */
export function loadSideTab(viewer: SideTabViewer): string | null {
  try {
    return globalThis.localStorage?.getItem(key(viewer)) ?? null;
  } catch {
    return null;
  }
}

export function saveSideTab(viewer: SideTabViewer, id: string): void {
  try {
    globalThis.localStorage?.setItem(key(viewer), id);
  } catch {
    // Not remembered: the next visit starts on the default tab.
  }
}

export interface SideTab {
  /** The tab shown: the chosen one while it exists (`ids`), else the default. */
  active: Accessor<string>;
  /** Choose a tab and remember it. */
  set: (id: string) => void;
}

/** A viewer's tab: starts on the remembered one, `fallback` when that is missing or not offered. */
export function createSideTab(
  viewer: SideTabViewer,
  fallback: string,
  ids: () => readonly string[],
): SideTab {
  const [chosen, setChosen] = createSignal(loadSideTab(viewer) ?? fallback);
  return {
    active: () => {
      const c = chosen();
      return ids().includes(c) ? c : fallback;
    },
    set: (id) => {
      setChosen(id);
      saveSideTab(viewer, id);
    },
  };
}

/**
 * Show the Cell tab when a cell is picked (the field of view, the QC table, a
 * neighbour link), except while `hold()` (the FOV held in the History tab
 * while History is expanded: the pick happens there, and the tab stays).
 */
export function showPickedCell(
  tab: SideTab,
  selected: Accessor<number | null>,
  hold: () => boolean,
): void {
  createEffect(
    on(
      selected,
      (id) => {
        if (id !== null && !hold()) tab.set('cell');
      },
      { defer: true },
    ),
  );
}
