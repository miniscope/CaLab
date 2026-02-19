// TutorialPanel: lists all available tutorials with progress state and prerequisite gating.

import { For, Show, type JSX } from 'solid-js';
import { tutorials } from '../../lib/tutorial/content/index.ts';
import { isCompleted, getProgress } from '@calab/tutorials';
import { startTutorial } from '../../lib/tutorial/tutorial-engine.ts';
import { isTutorialActive } from '../../lib/tutorial/tutorial-store.ts';
import { importStep } from '../../lib/data-store.ts';
import type { Tutorial } from '@calab/tutorials';

interface TutorialPanelProps {
  onClose: () => void;
}

/** Check if all prerequisites for a tutorial are met. */
function arePrerequisitesMet(tutorial: Tutorial): boolean {
  return tutorial.prerequisites.every((prereqId) => isCompleted(prereqId));
}

/** Get the display name for a prerequisite tutorial ID. */
function getPrereqName(prereqId: string): string {
  const found = tutorials.find((t) => t.id === prereqId);
  return found ? found.title : prereqId;
}

export function TutorialPanel(props: TutorialPanelProps): JSX.Element {
  const dataReady = () => importStep() === 'ready';

  const handleCardClick = (tutorial: Tutorial) => {
    const needsData = tutorial.requiresData !== false;
    if (needsData && !dataReady()) return;
    if (!arePrerequisitesMet(tutorial)) return;
    if (isTutorialActive()) return;

    const progress = getProgress(tutorial.id);
    const resumeStep =
      progress && !progress.completed && progress.lastStepIndex > 0
        ? progress.lastStepIndex
        : undefined;

    startTutorial(tutorial, resumeStep);
    props.onClose();
  };

  return (
    <div class="tutorial-panel">
      <For each={tutorials}>
        {(tutorial) => {
          const completed = () => isCompleted(tutorial.id);
          const progress = () => getProgress(tutorial.id);
          const prereqsMet = () => arePrerequisitesMet(tutorial);
          const locked = () => !prereqsMet();

          const statusText = () => {
            if (completed()) return 'Completed';
            const p = progress();
            if (p && p.lastStepIndex > 0) {
              return `Resume from step ${p.lastStepIndex + 1}`;
            }
            return 'Start';
          };

          return (
            <div
              class={`tutorial-card${locked() ? ' tutorial-card--locked' : ''}${completed() ? ' tutorial-card--completed' : ''}`}
              onClick={() => handleCardClick(tutorial)}
            >
              <div class="tutorial-card__title">
                <Show when={completed()}>
                  <span style={{ color: 'var(--success)', 'margin-right': '6px' }}>&#10003;</span>
                </Show>
                {tutorial.title}
                <Show when={tutorial.recommended}>
                  <span class="recommended-badge">Recommended</span>
                </Show>
              </div>
              <div class="tutorial-card__meta">
                <span class={`level-badge level-badge--${tutorial.level}`}>{tutorial.level}</span>
                <span>{tutorial.estimatedMinutes} min</span>
              </div>
              <div class="tutorial-card__description">{tutorial.description}</div>
              <div class="tutorial-card__status">
                <Show when={locked()}>
                  <span style={{ color: 'var(--warning)' }}>
                    Complete {tutorial.prerequisites.map(getPrereqName).join(', ')} first
                  </span>
                </Show>
                <Show when={!locked() && !dataReady() && tutorial.requiresData !== false}>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    Load data first to start tutorials
                  </span>
                </Show>
                <Show when={!locked() && (dataReady() || tutorial.requiresData === false)}>
                  <span style={{ color: completed() ? 'var(--success)' : 'var(--accent)' }}>
                    {statusText()}
                  </span>
                </Show>
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
}
