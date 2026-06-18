// Tutorial content registry.
// Aggregates all CaDecon tutorial definitions in progression order.

import type { Tutorial } from '@calab/tutorials';
import { basicsTutorial } from './01-basics.ts';
import { subsetsTutorial } from './02-subsets.ts';
import { theoryTutorial } from './03-theory.ts';
import { interpretingTutorial } from './04-interpreting.ts';
import { configureStorageKey, configureTutorialEngine } from '@calab/tutorials';
// ... existing imports ...
import '@calab/ui/styles/tutorial.css';

configureStorageKey('cadecon-tutorial-progress-v1');   // already present
configureTutorialEngine({ popoverClass: 'cadecon-tutorial' });
/** All tutorials in recommended progression order. */
export const tutorials: Tutorial[] = [
  theoryTutorial,
  basicsTutorial,
  subsetsTutorial,
  interpretingTutorial,
];

/** Look up a tutorial by its unique ID. */
export function getTutorialById(id: string): Tutorial | undefined {
  return tutorials.find((t) => t.id === id);
}