// Data-source bucket matching for the community browser.

import type { DataSource } from '@calab/community';

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
