// Reactive tutorial state using SolidJS signals.
// Follows the same module-level signal pattern as viz-store.ts and multi-cell-store.ts.

import { createSignal } from 'solid-js';
import type { Tutorial } from '@calab/tutorials';

// --- Signals ---

/** The currently active tutorial definition, or null when no tutorial is running. */
const [activeTutorial, setActiveTutorial] = createSignal<Tutorial | null>(null);

/** Current step index within the active tutorial (0-indexed). */
const [currentStepIndex, setCurrentStepIndex] = createSignal<number>(0);

/** Whether a tutorial tour is currently active. */
const [isTutorialActive, setIsTutorialActive] = createSignal<boolean>(false);

/** Flag set when user performs the required action for an interactive step. */
const [tutorialActionFired, setTutorialActionFired] = createSignal<boolean>(false);

// --- Exports ---

export {
  // Getters (signals)
  activeTutorial,
  currentStepIndex,
  isTutorialActive,
  tutorialActionFired,
  // Setters
  setActiveTutorial,
  setCurrentStepIndex,
  setIsTutorialActive,
  setTutorialActionFired,
};
