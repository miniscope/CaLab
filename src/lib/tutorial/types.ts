// Tutorial system type definitions.
// Data-driven step definitions per TUTR-05 (content separate from engine).

/** A single step in a tutorial tour. */
export interface TutorialStep {
  /** CSS selector for the target element (e.g., '[data-tutorial="slider-decay"]'). Omit for centered modal. */
  element?: string;
  /** Popover title text. */
  title: string;
  /** Popover description (supports HTML for formatting). */
  description: string;
  /** Which side of the element to show the popover. */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Require user to perform an action before advancing (e.g., 'slider-change'). */
  waitForAction?: string;
  /** Optional parameter values to set for this step's demonstration. */
  setupParams?: {
    tauRise?: number;
    tauDecay?: number;
    lambda?: number;
  };
  /** Whether to disable interaction with the highlighted element. Undefined = driver.js default. */
  disableActiveInteraction?: boolean;
  /** Called after popover renders. Receives description HTMLElement for canvas injection.
   *  May return a cleanup function. */
  onPopoverRender?: (descriptionEl: HTMLElement) => (() => void) | void;
}

/** A complete tutorial definition with metadata and step array. */
export interface Tutorial {
  /** Unique identifier (e.g., 'basics', 'workflow'). */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Short description of what the tutorial covers. */
  description: string;
  /** Difficulty level for progressive disclosure. */
  level: 'beginner' | 'intermediate' | 'advanced' | 'theory';
  /** Tutorial IDs that should be completed before this one. */
  prerequisites: string[];
  /** Estimated completion time in minutes. */
  estimatedMinutes: number;
  /** Highlight this tutorial as recommended in the tutorial panel. */
  recommended?: boolean;
  /** Whether this tutorial requires data to be loaded. Defaults to true. */
  requiresData?: boolean;
  /** Ordered array of tutorial steps. */
  steps: TutorialStep[];
}

/** Persisted progress for a single tutorial. */
export interface TutorialProgress {
  /** Which tutorial this progress is for. */
  tutorialId: string;
  /** Last step the user reached (0-indexed). */
  lastStepIndex: number;
  /** Whether the tutorial was completed. */
  completed: boolean;
  /** Timestamp (ms since epoch) of last update. */
  timestamp: number;
}
