// Reactive analytics integration for CaTune.
// Uses createEffect(on(...)) to watch store signals and fire events.
// Keeps data-store.ts and viz-store.ts pure of analytics concerns.

import { createEffect, on } from 'solid-js';
import { trackEvent } from '@calab/community';
import { importStep, isDemo, rawFile } from './data-store.ts';
import { user } from './community/community-store.ts';

let prevImportStep: string | null = null;
let prevUser: unknown = undefined;

export function setupAnalyticsEffects(): void {
  // Track file_imported / demo_loaded when importStep transitions to 'ready'
  createEffect(
    on(importStep, (step) => {
      if (step === 'ready' && prevImportStep !== 'ready') {
        if (isDemo()) {
          void trackEvent('demo_loaded');
        } else if (rawFile()) {
          void trackEvent('file_imported', {
            extension: rawFile()?.name.split('.').pop() ?? 'unknown',
          });
        }
      }
      prevImportStep = step;
    }),
  );

  // Track auth_signed_in / auth_signed_out on user transitions
  createEffect(
    on(user, (currentUser) => {
      if (prevUser === undefined) {
        // Initial load — don't fire event
        prevUser = currentUser;
        return;
      }
      if (currentUser && !prevUser) {
        void trackEvent('auth_signed_in');
      } else if (!currentUser && prevUser) {
        void trackEvent('auth_signed_out');
      }
      prevUser = currentUser;
    }),
  );
}
