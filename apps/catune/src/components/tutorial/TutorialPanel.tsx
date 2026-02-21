// CaTune TutorialPanel — thin wrapper around shared @calab/ui TutorialPanel.

import type { JSX } from 'solid-js';
import { TutorialPanel as SharedTutorialPanel } from '@calab/ui';
import { startTutorial } from '@calab/tutorials';
import type { Tutorial } from '@calab/tutorials';
import { trackEvent } from '@calab/community';
import { tutorials } from '../../lib/tutorial/content/index.ts';
import { importStep } from '../../lib/data-store.ts';

interface TutorialPanelProps {
  onClose: () => void;
}

export function TutorialPanel(props: TutorialPanelProps): JSX.Element {
  const handleStart = (tutorial: Tutorial, resumeFromStep?: number) => {
    void trackEvent('tutorial_started', { tutorial_id: tutorial.id });
    startTutorial(tutorial, resumeFromStep);
  };

  return (
    <SharedTutorialPanel
      tutorials={tutorials}
      isDataReady={() => importStep() === 'ready'}
      onStartTutorial={handleStart}
      onClose={props.onClose}
    />
  );
}
