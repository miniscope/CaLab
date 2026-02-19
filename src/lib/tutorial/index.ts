// Barrel file — public API for the tutorial module.
// Import from 'lib/tutorial' rather than reaching into internals.

export { saveProgress, getProgress, getAllProgress, isCompleted } from './progress.ts';
export {
  renderKernelShape,
  renderDecayComparison,
  renderDeltaTrap,
  renderGoodVsBad,
} from './theory-figures.ts';
export { startTutorial, stopTutorial, notifyTutorialAction } from './tutorial-engine.ts';
export {
  activeTutorial,
  currentStepIndex,
  isTutorialActive,
  tutorialActionFired,
  setActiveTutorial,
  setCurrentStepIndex,
  setIsTutorialActive,
  setTutorialActionFired,
} from './tutorial-store.ts';
export type { TutorialStep, Tutorial, TutorialProgress } from './types.ts';
