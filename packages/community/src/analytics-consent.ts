// Usage-analytics opt-out, shared by every app.
//
// Stored in localStorage under `calab_analytics_off`:
//   '1'  the user turned analytics off  -> off
//   '0'  the user turned analytics on   -> on (overrides Do Not Track)
//   none the user has not chosen        -> on, unless the browser sends
//                                          Do Not Track (`navigator.doNotTrack === '1'`)
// All storage access is wrapped: a blocked or missing localStorage means "no
// choice made", never an error. Same-origin pages (landing page, every app)
// share the key.

export const ANALYTICS_OFF_KEY = 'calab_analytics_off';

function doNotTrack(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.doNotTrack === '1';
  } catch {
    return false;
  }
}

function storedChoice(): '1' | '0' | null {
  try {
    const v = localStorage.getItem(ANALYTICS_OFF_KEY);
    return v === '1' || v === '0' ? v : null;
  } catch {
    return null;
  }
}

/** True when events may be sent (no opt-out, no Do Not Track without an explicit opt-in). */
export function analyticsEnabled(): boolean {
  const choice = storedChoice();
  if (choice === '1') return false;
  if (choice === '0') return true;
  return !doNotTrack();
}

/** Record the user's choice. Never throws; returns the resulting state. */
export function setAnalyticsEnabled(enabled: boolean): boolean {
  try {
    localStorage.setItem(ANALYTICS_OFF_KEY, enabled ? '0' : '1');
  } catch {
    // Storage blocked: the choice cannot persist; fall through to the current state.
  }
  return analyticsEnabled();
}
