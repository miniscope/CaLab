// Re-export package API + local modules
export type { TutorialStep, Tutorial, TutorialProgress } from '@catune/tutorials';
export { saveProgress, getProgress, getAllProgress, isCompleted } from '@catune/tutorials';
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
