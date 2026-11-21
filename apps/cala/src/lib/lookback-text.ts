/** The Run panel's line on a look-back run (experimental). */
import type { LookbackStatus, SettleStatus } from '../workers/lookback-types.ts';
import { SETTLE } from './settle.ts';

/** "N of C cells still moving (more than 2x their noise)" at the settle's last checkpoint ('' before it). */
function movingText(st: SettleStatus): string {
  const m = st.moving;
  if (!m || m.cells === 0) return '';
  const share = m.above / m.cells;
  const verdict = share > SETTLE.movingShare ? ' (not settled yet)' : '';
  return ` · ${m.above} of ${m.cells} cells still moving${verdict}`;
}

/** The settle's frames: "12,000 of 18,000 frames" (and the recording's length when it was sampled). */
function settleFrames(st: SettleStatus): string {
  const of = `${st.fed.toLocaleString()} of ${st.total.toLocaleString()} frames`;
  return st.total < st.recording ? `${of} (spread over ${st.recording.toLocaleString()})` : of;
}

/** One line on a look-back run (experimental): what it re-read, and the settle after the last frame. */
export function lookbackText(lb: LookbackStatus, final: boolean): string {
  const err = lb.error ? ` · look-back stopped: ${lb.error}` : '';
  const st = lb.settle;
  if (lb.settling && st) return `Settling: ${settleFrames(st)}${movingText(st)}${err}`;
  if (lb.settling) return `Settling${err}`;
  const read = `${lb.pushed.toLocaleString()} frames re-read for ${lb.births} new cells`;
  if (final && st) {
    const end = st.stopped
      ? `settling stopped by you after ${settleFrames(st)}`
      : `settled over ${settleFrames(st)}`;
    return `Look-back: ${read} · ${end}${movingText(st)}${err}`;
  }
  return `Look-back: ${read} · ${lb.inNeed} cells still need data${err}`;
}
