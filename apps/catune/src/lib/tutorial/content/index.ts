// Tutorial content registry.
// Aggregates all tutorial definitions in progression order.

import type { Tutorial } from '@calab/tutorials';
import { basicsTutorial } from './01-basics.ts';
import { workflowTutorial } from './02-workflow.ts';
import { advancedTutorial } from './03-advanced.ts';
import { featuresTutorial } from './04-features.ts';
import { theoryTutorial } from './05-theory.ts';

/** All tutorials in recommended progression order. */
export const tutorials: Tutorial[] = [
  theoryTutorial,
  basicsTutorial,
  workflowTutorial,
  advancedTutorial,
  featuresTutorial,
];

/** Look up a tutorial by its unique ID. */
export function getTutorialById(id: string): Tutorial | undefined {
  return tutorials.find((t) => t.id === id);
}
