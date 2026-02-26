// Reactive analytics integration for CaTune.
// Uses createEffect(on(...)) to watch store signals and fire events.
// Keeps data-store.ts and viz-store.ts pure of analytics concerns.

import { createEffect, on } from 'solid-js';
import { trackEvent } from '@calab/community';
import { importStep, isDemo, rawFile } from './data-store.ts';
import { user } from './community/index.ts';

export function setupAnalyticsEffects(): void {
  // Track file_imported / demo_loaded when importStep transitions to 'ready'
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

  // Track auth_signed_in / auth_signed_out on user transitions.
  // defer: true skips the initial value so the first sign-in state is not tracked.
  createEffect(
    on(
      user,
      (currentUser, prevUser) => {
        if (currentUser && !prevUser) {
          void trackEvent('auth_signed_in');
        } else if (!currentUser && prevUser) {
          void trackEvent('auth_signed_out');
        }
      },
      { defer: true },
    ),
  );
}
