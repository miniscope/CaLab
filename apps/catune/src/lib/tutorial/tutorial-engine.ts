// Tutorial engine: driver.js integration for CaTune's guided tours.
// Maps typed Tutorial objects to driver.js DriveStep arrays and manages lifecycle.

import { driver, type DriveStep, type Config, type Driver, type PopoverDOM } from 'driver.js';
import 'driver.js/dist/driver.css';
import '../../styles/tutorial.css';

import type { Tutorial } from '@calab/tutorials';
import {
  setActiveTutorial,
  currentStepIndex,
  setCurrentStepIndex,
  setIsTutorialActive,
  tutorialActionFired,
  setTutorialActionFired,
  isTutorialActive,
} from './tutorial-store.ts';
import { saveProgress } from '@calab/tutorials';

// --- Module state ---

let driverInstance: Driver | null = null;
let activeRenderCleanup: (() => void) | null = null;

/** Run and clear any active figure render cleanup. */
function cleanupActiveRender(): void {
  if (activeRenderCleanup) {
    activeRenderCleanup();
    activeRenderCleanup = null;
  }
}

// --- Step mapping ---

/**
 * Convert typed TutorialStep array to driver.js DriveStep array.
 * Handles interactive steps (waitForAction) by overriding onNextClick
 * to block manual advancement until the action fires.
 */
function mapSteps(tutorial: Tutorial): DriveStep[] {
  return tutorial.steps.map((step, index) => {
    const renderFn = step.onPopoverRender;

    const driveStep: DriveStep = {
      element: step.element,
      popover: {
        title: step.title,
        description: step.description,
        side: step.side,
        ...(renderFn && {
          onPopoverRender: (popover: PopoverDOM) => {
            popover.wrapper.classList.add('catune-tutorial-figure');
            cleanupActiveRender();
            const cleanup = renderFn(popover.description);
            if (cleanup) activeRenderCleanup = cleanup;
          },
        }),
      },
    };

    // Set disableActiveInteraction if explicitly specified
    if (step.disableActiveInteraction !== undefined) {
      driveStep.disableActiveInteraction = step.disableActiveInteraction;
    }

    // Interactive steps: block next button until user performs required action
    if (step.waitForAction) {
      // Allow interaction with the highlighted element
      driveStep.disableActiveInteraction = false;

      driveStep.onHighlighted = () => {
        setCurrentStepIndex(index);
        // Reset action flag when entering an interactive step
        setTutorialActionFired(false);
      };

      driveStep.popover = {
        ...driveStep.popover,
        onNextClick: () => {
          // Only allow manual advancement once the action has been performed
          if (tutorialActionFired()) {
            driverInstance?.moveNext();
          }
        },
      };
    }

    return driveStep;
  });
}

// --- Public API ---

/**
 * Start a tutorial tour. Optionally resume from a specific step index.
 * Destroys any currently active tour before starting.
 */
export function startTutorial(tutorial: Tutorial, resumeFromStep?: number): void {
  // Clean up any existing tour
  if (driverInstance) {
    driverInstance.destroy();
    driverInstance = null;
  }

  const steps = mapSteps(tutorial);

  const config: Config = {
    steps,
    showProgress: true,
    progressText: '{{current}} of {{total}}',
    animate: true,
    allowClose: true,
    overlayOpacity: 0.6,
    popoverClass: 'catune-tutorial',

    // Track step transitions: update reactive store and persist progress
    onHighlightStarted: (_element, _step, { driver: drv }) => {
      cleanupActiveRender();
      const activeIdx = drv.getActiveIndex();
      if (activeIdx !== undefined) {
        setCurrentStepIndex(activeIdx);
        saveProgress(tutorial.id, activeIdx, false);
      }
    },

    // Handle tour destruction: persist completion and reset reactive state
    onDestroyed: () => {
      cleanupActiveRender();

      // Only mark completed if user reached the final step
      const lastIndex = tutorial.steps.length - 1;
      const reachedEnd = currentStepIndex() >= lastIndex;
      saveProgress(tutorial.id, currentStepIndex(), reachedEnd);
      setIsTutorialActive(false);
      setActiveTutorial(null);
      driverInstance = null;
    },
  };

  driverInstance = driver(config);

  // Update reactive state
  setActiveTutorial(tutorial);
  setCurrentStepIndex(resumeFromStep ?? 0);
  setIsTutorialActive(true);

  // Start the tour
  driverInstance.drive(resumeFromStep ?? 0);
}

/** Stop the currently active tutorial without marking it as completed. */
export function stopTutorial(): void {
  driverInstance?.destroy();
}

/**
 * Notify the tutorial engine that the user performed the required action
 * for an interactive step. Sets the action flag and auto-advances the tour.
 */
export function notifyTutorialAction(): void {
  setTutorialActionFired(true);
  if (isTutorialActive() && driverInstance) {
    driverInstance.moveNext();
  }
}
