import type { JSX } from 'solid-js';
import { ImportOverlay as SharedImportOverlay, type DemoLoadRequest } from '@calab/ui/import';
import { ImportFeedbackLinks } from '@calab/community-ui';
import { startTutorial } from '@calab/tutorials';
import { importStore } from '../../lib/data-store.ts';
import { getTutorialById } from '../../lib/tutorial/content/index.ts';

export interface ImportOverlayProps {
  hasFile: boolean;
  onReset: () => void;
  onLoadDemo: (opts: DemoLoadRequest) => void;
}

export function ImportOverlay(props: ImportOverlayProps): JSX.Element {
  return (
    <SharedImportOverlay
      store={importStore}
      title="CaTune"
      subtitle="Calcium Deconvolution Parameter Tuning"
      version={`CaLab ${import.meta.env.VITE_APP_VERSION || 'dev'}`}
      layout="stacked"
      demoButtonLabel="Load Demo Data"
      samplingRatePurpose="parameter tuning"
      headerTutorialAnchor="app-header"
      readyStep={{
        message: 'Data loaded and validated. Ready for parameter tuning.',
        tracePreviewCaption: 'Full interactive plotting available after parameter tuning.',
        cellIndexBase: 1,
      }}
      theoryTutorial={{
        prompt: 'New to deconvolution?',
        onStart: () => {
          const theory = getTutorialById('theory');
          if (theory) startTutorial(theory);
        },
      }}
      footer={<ImportFeedbackLinks appId={__APP_ID__} />}
      hasFile={props.hasFile}
      onReset={props.onReset}
      onLoadDemo={props.onLoadDemo}
    />
  );
}
