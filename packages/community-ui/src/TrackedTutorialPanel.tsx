// The @calab/ui TutorialPanel wired to the tutorial engine, logging a
// `tutorial_started` analytics event for each start (used by CaTune and CaDecon).

import type { JSX } from 'solid-js';
import { TutorialPanel, type TutorialPanelProps } from '@calab/ui';
import { startTutorial, type Tutorial } from '@calab/tutorials';
import { trackEvent } from '@calab/community';

export type TrackedTutorialPanelProps = Omit<TutorialPanelProps, 'onStartTutorial'>;

export function TrackedTutorialPanel(props: TrackedTutorialPanelProps): JSX.Element {
  const handleStart = (tutorial: Tutorial, resumeFromStep?: number) => {
    void trackEvent('tutorial_started', { tutorial_id: tutorial.id });
    startTutorial(tutorial, resumeFromStep);
  };

  return (
    <TutorialPanel
      tutorials={props.tutorials}
      isDataReady={props.isDataReady}
      onStartTutorial={handleStart}
      onClose={props.onClose}
    />
  );
}
