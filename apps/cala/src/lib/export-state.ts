/** Whether the current result has been exported by hand (so leaving the run can warn when it has not). */
import { createSignal } from 'solid-js';

const [exported, setExported] = createSignal(false);

export const resultExported = exported;
export const markResultExported = (): void => void setExported(true);
export const clearResultExported = (): void => void setExported(false);

/** The warning shown before a finished, unsaved result is dropped; null when there is nothing to lose. */
export function leaveWarning(o: {
  extractDone: boolean;
  exported: boolean;
  /** Its run wrote the result into the run folder (or its zip). */
  written: boolean;
}): string | null {
  if (!o.extractDone || o.exported || o.written) return null;
  return 'The result of this run has not been exported. Leave without exporting it?';
}
