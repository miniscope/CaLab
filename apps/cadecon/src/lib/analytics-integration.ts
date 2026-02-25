// Reactive analytics integration for CaDecon.
// Uses createEffect(on(...)) to watch store signals and fire events.

import { createEffect, on } from 'solid-js';
import { trackEvent } from '@calab/community';
import { importStep, isDemo, rawFile } from './data-store.ts';

export function setupAnalyticsEffects(): void {
  createEffect(
    on(importStep, (step, prevStep) => {
      if (step === 'ready' && prevStep !== 'ready') {
        if (isDemo()) {
          void trackEvent('demo_loaded');
        } else if (rawFile()) {
          void trackEvent('file_imported', {
            extension: rawFile()?.name.split('.').pop() ?? 'unknown',
          });
        }
      }
    }),
  );
}
