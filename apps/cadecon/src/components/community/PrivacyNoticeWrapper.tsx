/**
 * CaDecon PrivacyNotice — thin wrapper with CaDecon-specific content.
 */

import { PrivacyNotice as SharedPrivacyNotice } from '@calab/ui';

export function PrivacyNotice() {
  return (
    <SharedPrivacyNotice
      sharedItems={
        <>
          When you submit, CaDecon sends only: kernel parameters (tau_rise, tau_decay, beta),
          aggregate statistics (median alpha, median PVE, mean event rate), run configuration, your
          experimental metadata (indicator, species, brain region), and a dataset fingerprint for
          duplicate detection.
        </>
      }
      retainedItems={
        <>
          Your raw fluorescence traces, deconvolved activity, and any file data remain entirely in
          your browser's memory. No trace data is ever transmitted to any server.
        </>
      }
    />
  );
}
