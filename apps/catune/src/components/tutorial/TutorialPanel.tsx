// CaTune TutorialPanel — thin wrapper around shared @calab/ui TutorialPanel.

import type { JSX } from 'solid-js';
import { TutorialPanel as SharedTutorialPanel } from '@calab/ui';
import { startTutorial } from '@calab/tutorials';
import { tutorials } from '../../lib/tutorial/content/index.ts';
import { importStep } from '../../lib/data-store.ts';

interface TutorialPanelProps {
  onClose: () => void;
}

export function TutorialPanel(props: TutorialPanelProps): JSX.Element {
  return (
    <SharedTutorialPanel
      tutorials={tutorials}
      isDataReady={() => importStep() === 'ready'}
      onStartTutorial={startTutorial}
      onClose={props.onClose}
    />
  );
}
