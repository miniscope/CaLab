// Row matching for the community browser's data-source and demo-preset filters.

import type { BaseSubmission, DataSource } from '@calab/community';
import { readDemoPreset } from '@calab/community';

/**
 * Does a submission's stored `data_source` belong in the currently selected
 * browser bucket? The browser's source toggle only ever selects 'demo' or
 * 'user' (bridge/training collapse to 'user' — see the appDataSource effect in
 * CommunityBrowserShell), but submissions are stored with their exact source
 * ('bridge', 'training', ...). So the 'user' bucket must match every non-demo
 * source, otherwise bridge/training submissions are silently filtered out and
 * never appear in the browser.
 */
export function matchesSourceBucket(rowSource: DataSource, bucket: DataSource): boolean {
  return bucket === 'demo' ? rowSource === 'demo' : rowSource !== 'demo';
}

/**
 * Does a submission match the selected simulated-indicator filter?
 *
 * Only demo rows carry a recorded indicator, so non-demo rows always pass —
 * the source bucket already keeps them out of the demo view. Demo rows
 * submitted before the id was recorded can't be attributed to an indicator, so
 * they drop out once a specific one is selected.
 */
export function matchesDemoPreset(
  row: Pick<BaseSubmission, 'data_source' | 'extra_metadata'>,
  selectedPreset: string | null,
): boolean {
  if (!selectedPreset) return true;
  if (row.data_source !== 'demo') return true;
  return readDemoPreset(row.extra_metadata) === selectedPreset;
}
