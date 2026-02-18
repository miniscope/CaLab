// Tutorial progress persistence via localStorage.
// Tracks completion state and last step for resume support.

import type { TutorialProgress } from './types.ts';

const STORAGE_KEY = 'catune-tutorial-progress-v2';

/** Save progress for a tutorial (creates or updates entry). */
export function saveProgress(
  tutorialId: string,
  stepIndex: number,
  completed: boolean,
): void {
  const all = getAllProgress();
  all[tutorialId] = {
    tutorialId,
    lastStepIndex: stepIndex,
    completed,
    timestamp: Date.now(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // localStorage full or unavailable -- silently ignore
  }
}

/** Get progress for a specific tutorial, or null if none saved. */
export function getProgress(tutorialId: string): TutorialProgress | null {
  const all = getAllProgress();
  return all[tutorialId] ?? null;
}

/** Get all saved tutorial progress. Returns empty object on parse error. */
export function getAllProgress(): Record<string, TutorialProgress> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, TutorialProgress>) : {};
  } catch {
    return {};
  }
}

/** Check if a tutorial has been completed. */
export function isCompleted(tutorialId: string): boolean {
  return getProgress(tutorialId)?.completed ?? false;
}
