// Optional, opt-in "beta tester tag": a short name the user may type so the
// developers can recognise their runs. It is the only user-typed value any
// analytics event carries. Stored in localStorage (`calab_tester_tag`), sent
// only as the `tester_tag` event (once per session and when it changes), and
// only while analytics are enabled (opt-out and Do Not Track win).

import { analyticsEnabled } from './analytics-consent.ts';

export const TESTER_TAG_KEY = 'calab_tester_tag';
export const TESTER_TAG_MAX = 32;

/** Strip disallowed characters ([A-Za-z0-9 ._@-] stay), trim, cap at 32. */
export function sanitizeTesterTag(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9 ._@-]/g, '')
    .trim()
    .slice(0, TESTER_TAG_MAX)
    .trim();
}

/** The stored tag ('' when none, blocked storage, or analytics are off). */
export function getTesterTag(): string {
  if (!analyticsEnabled()) return '';
  try {
    return sanitizeTesterTag(localStorage.getItem(TESTER_TAG_KEY) ?? '');
  } catch {
    return '';
  }
}

/** Store the (sanitised) tag; empty clears it. Returns what was stored. Never throws. */
export function setTesterTag(raw: string): string {
  const tag = sanitizeTesterTag(raw);
  try {
    if (tag) localStorage.setItem(TESTER_TAG_KEY, tag);
    else localStorage.removeItem(TESTER_TAG_KEY);
  } catch {
    // Storage blocked: the tag cannot persist.
  }
  return tag;
}
