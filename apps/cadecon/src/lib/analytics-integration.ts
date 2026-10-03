import { createEffect, on } from 'solid-js';
import { trackEvent, user, authLoading } from '@calab/community';
import { importStep, isDemo, rawFile } from './data-store.ts';

export function setupAnalyticsEffects(): void {
  // Data import events
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

  // Auth events
  let wasSignedIn = false;
  // Reads the shared community store instead of opening a second auth
  // subscription.
  createEffect(() => {
    if (authLoading()) return;
    const isSignedIn = user() !== null;
    if (isSignedIn && !wasSignedIn) {
      void trackEvent('auth_signed_in');
    } else if (!isSignedIn && wasSignedIn) {
      void trackEvent('auth_signed_out');
    }
    wasSignedIn = isSignedIn;
  });
}
