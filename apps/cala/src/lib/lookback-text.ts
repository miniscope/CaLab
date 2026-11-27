/** The Run panel's line on a look-back run. */
import type { CsettleStatus, LookbackStatus, SettleStatus } from '../workers/lookback-types.ts';
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

/**
 * " · 0.40 visits/frame" while the settle runs at a visit rate, the visits it made per frame once
 * done (on the visit workers; '' without a rate).
 */
function visitsText(st: SettleStatus, done: boolean): string {
  const v = st.visits;
  if (!v || !(v.rate > 0)) return '';
  if (!done || !(st.fed > 0)) return ` · ${v.rate.toFixed(2)} visits/frame`;
  return ` · ${(v.handed / st.fed).toFixed(2)} visits/frame`;
}

/** Frames the settle during Discover has re-read (fitted, held out or dropped: every frame that came back). */
export function csettleReread(cs: CsettleStatus): number {
  return cs.fit + cs.heldOut + cs.dropped;
}

/** "0.42" re-read frames per live frame so far ('' before the first live frame). */
function perLive(cs: CsettleStatus): string {
  if (!(cs.live > 0)) return '';
  const r = csettleReread(cs) / cs.live;
  return `${r >= 0.995 ? r.toFixed(1) : r.toFixed(2)} per live frame`;
}

/**
 * The settle during Discover ('' when off): while Discover runs, the frames
 * re-read so far against the ceiling; afterwards, how many were re-read
 * during Discover.
 */
export function csettleText(cs: CsettleStatus | undefined, running: boolean): string {
  if (!cs) return '';
  const n = csettleReread(cs).toLocaleString();
  const rate = perLive(cs);
  if (running)
    return ` · Background settle: ${n} saved frames re-read (${rate ? `${rate}, ` : ''}ceiling ${cs.rate})`;
  return ` · ${n} frames re-read by the Background settle${rate ? ` (${rate})` : ''}`;
}

/** One line on a look-back run: what it re-read, and the settle after the last frame. */
export function lookbackText(lb: LookbackStatus, final: boolean): string {
  const err = lb.error ? ` · look-back stopped: ${lb.error}` : '';
  const st = lb.settle;
  const on =
    st?.source === 'factors'
      ? ' on the factors'
      : st?.source === 'file' && st.fileReason
        ? ` (re-reads the file: ${st.fileReason})`
        : '';
  if (lb.settling && st?.waiting)
    return `Final settle: waiting for the last factor window${csettleText(lb.csettle, false)}${err}`;
  if (lb.settling && st)
    return `Final settle${on}: ${settleFrames(st)}${visitsText(st, false)}${movingText(st)}${csettleText(lb.csettle, false)}${err}`;
  if (lb.settling) return `Final settle${csettleText(lb.csettle, false)}${err}`;
  const read = `${lb.pushed.toLocaleString()} frames re-read for ${lb.births} new cells`;
  if (final && st?.error)
    return `Look-back: ${read}${csettleText(lb.csettle, false)} · Final settle skipped: ${st.error}${err}`;
  if (final && st) {
    const end = st.stopped
      ? `final settle stopped by you after ${settleFrames(st)}`
      : `final settle${on} over ${settleFrames(st)}${visitsText(st, true)}`;
    return `Look-back: ${read}${csettleText(lb.csettle, false)} · ${end}${movingText(st)}${err}`;
  }
  return `Look-back: ${read} · ${lb.inNeed} cells still need data${csettleText(lb.csettle, true)}${err}`;
}

/** The stage after Discover ended, for the status chip: Final settle, Extract, Done ("Discover done" before Extract). */
export function stageLabel(s: {
  discover: string;
  settling: boolean;
  extract: string;
  /** A live stream: nothing follows Discover, so its end is Done. */
  live?: boolean;
  /** A `?factors` stream: Extract follows its Discover as a recording's does. */
  factorRun?: boolean;
}): string {
  if (s.discover !== 'done') return 'Discover';
  if (s.settling) return 'Final settle';
  if (s.live && !s.factorRun) return 'Done';
  if (s.extract === 'running') return 'Extract';
  if (s.extract === 'done') return 'Done';
  return 'Discover done';
}
