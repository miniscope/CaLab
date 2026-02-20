# @calab/tutorials

Tutorial type definitions, progress persistence, and tutorial engine for the CaLab monorepo.

This is a **leaf package** with no local `@calab/*` dependencies. External dependencies: `driver.js` (step-by-step UI highlighting), `solid-js` (reactive signals for tutorial state).

```
@calab/tutorials  ← leaf
  ↑
apps/catune
```

## Exports

| Export                                                                                      | Source               | Description                                                                        |
| ------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `TutorialStep`, `Tutorial`, `TutorialProgress`                                              | `types.ts`           | Type definitions for tutorial structure and progress                               |
| `saveProgress`, `getProgress`, `getAllProgress`, `isCompleted`, `configureStorageKey`       | `progress.ts`        | localStorage-based progress persistence                                            |
| `activeTutorial`, `currentStepIndex`, `isTutorialActive`, `tutorialActionFired` (+ setters) | `tutorial-store.ts`  | SolidJS signals for active tutorial state                                          |
| `startTutorial`, `stopTutorial`, `notifyTutorialAction`, `configureTutorialEngine`          | `tutorial-engine.ts` | Tutorial lifecycle management — start, stop, advance steps, handle action triggers |
