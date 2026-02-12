/**
 * General formatting utilities for UI display.
 */

/**
 * Format duration in seconds to a human-readable string.
 *
 * @param seconds - Duration in seconds (can be null)
 * @param showBoth - If true and duration >= 1 minute, shows "X.Xs (X.X min)".
 *                   If false, shows only "X.X min" for durations >= 1 minute.
 * @returns Formatted string or null if seconds is null
 *
 * @example
 * formatDuration(45) // "45.0s"
 * formatDuration(90) // "1.5 min"
 * formatDuration(90, true) // "90.0s (1.5 min)"
 */
export function formatDuration(seconds: number | null, showBoth: boolean = false): string | null {
  if (seconds === null) return null;

  const minutes = seconds / 60;

  if (minutes >= 1) {
    if (showBoth) {
      return `${seconds.toFixed(1)}s (${minutes.toFixed(1)} min)`;
    }
    return `${minutes.toFixed(1)} min`;
  }

  return `${seconds.toFixed(1)}s`;
}
