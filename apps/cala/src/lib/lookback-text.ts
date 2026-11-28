/**
 * A look-back run's figures for the Run tab, as data: the components draw them as meter rows
 * (`Steps.tsx`). Pure, so the figures are tested without a DOM.
 */
import type { CsettleStatus, LookbackStatus, SettleStatus } from '../workers/lookback-types.ts';
import { SETTLE } from './settle.ts';

/** Frames the settle during Discover has re-read (fitted, held out or dropped: every frame that came back). */
export function csettleReread(cs: CsettleStatus): number {
  return cs.fit + cs.heldOut + cs.dropped;
}

/** Background settle (settle during Discover). */
export interface CsettleFacts {
  /** Saved frames re-read so far. */
  reread: number;
  /** Re-read frames per live frame so far (null before the first live frame). */
  perLive: number | null;
  /** The ceiling on `perLive` in force (re-read frames per live frame). */
  ceiling: number;
}

/** Where the Final settle reads its frames: the factors, or the file (and why). Null: the recording, as usual. */
export type SettleSource = { kind: 'factors' } | { kind: 'file'; reason: string } | null;

/** The Final settle. */
export interface SettleFacts {
  /** Frames fed of the planned total. */
  fed: number;
  total: number;
  /** The recording's frames; above `total` when the settle samples them. */
  recording: number;
  source: SettleSource;
  /** Waiting for the last factor window before it can start. */
  waiting: boolean;
  /**
   * Visits per settle frame: the rate in force while it runs, the visits made per frame once
   * done (null without a rate, or before a frame once done).
   */
  visitsPerFrame: number | null;
  /** Cells still moving more than `SETTLE.movingK` times their noise at the last checkpoint (null before one). */
  moving: { above: number; cells: number } | null;
  /** Stopped by the user before its plan. */
  stopped: boolean;
}

/** Where a look-back run is. */
export type LookbackPhase = 'discover' | 'settling' | 'done' | 'skipped';

/** A look-back run's figures. */
export interface LookbackFacts {
  phase: LookbackPhase;
  /** Frames re-read for new cells, and the cells born with that data. */
  reread: number;
  births: number;
  /** Cells still waiting for look-back data. */
  inNeed: number;
  /** Null when Background settle is off. */
  csettle: CsettleFacts | null;
  /** Null before the Final settle reports, and when it was skipped. */
  settle: SettleFacts | null;
  /** Why the Final settle was skipped (`phase` 'skipped'). */
  skipped: string | null;
  /** Look-back stopped with this error (null: running or ended normally). */
  error: string | null;
}

function csettleFacts(cs: CsettleStatus | undefined): CsettleFacts | null {
  if (!cs) return null;
  return {
    reread: csettleReread(cs),
    perLive: cs.live > 0 ? csettleReread(cs) / cs.live : null,
    ceiling: cs.rate,
  };
}

function settleFacts(st: SettleStatus, done: boolean): SettleFacts {
  const v = st.visits;
  const visitsPerFrame =
    !v || !(v.rate > 0) ? null : !done ? v.rate : st.fed > 0 ? v.handed / st.fed : null;
  const source: SettleSource =
    st.source === 'factors'
      ? { kind: 'factors' }
      : st.source === 'file' && st.fileReason
        ? { kind: 'file', reason: st.fileReason }
        : null;
  return {
    fed: st.fed,
    total: st.total,
    recording: st.recording,
    source,
    waiting: st.waiting === true,
    visitsPerFrame,
    moving: st.moving && st.moving.cells > 0 ? { ...st.moving } : null,
    stopped: st.stopped,
  };
}

/** The figures of a look-back run; `final`: the final library is out. */
export function lookbackFacts(lb: LookbackStatus, final: boolean): LookbackFacts {
  const st = lb.settle;
  const phase: LookbackPhase = lb.settling
    ? 'settling'
    : final && st?.error
      ? 'skipped'
      : final
        ? 'done'
        : 'discover';
  return {
    phase,
    reread: lb.pushed,
    births: lb.births,
    inNeed: lb.inNeed,
    csettle: csettleFacts(lb.csettle),
    settle: st && phase !== 'skipped' ? settleFacts(st, phase === 'done') : null,
    skipped: phase === 'skipped' ? (st?.error ?? null) : null,
    error: lb.error ?? null,
  };
}

/** More than `SETTLE.movingShare` of the cells still move: not settled yet. */
export function notSettled(m: { above: number; cells: number }): boolean {
  return m.cells > 0 && m.above / m.cells > SETTLE.movingShare;
}

/**
 * The one short note beside the Final settle's figures: where it reads and why, a wait, a stop
 * or an error ('' when there is nothing to say).
 */
export function settleNote(f: LookbackFacts): string {
  const parts: string[] = [];
  const s = f.settle;
  if (f.phase === 'skipped') parts.push(`Final settle skipped: ${f.skipped}`);
  if (s?.waiting && f.phase === 'settling') parts.push('waiting for the last factor window');
  if (s?.source?.kind === 'factors') parts.push('on the factors');
  if (s?.source?.kind === 'file') parts.push(`re-reads the file: ${s.source.reason}`);
  if (s && s.total > 0 && s.total < s.recording)
    parts.push(`spread over ${s.recording.toLocaleString('en-US')} frames`);
  if (s?.stopped) parts.push('stopped by you');
  if (f.error) parts.push(`look-back stopped: ${f.error}`);
  return parts.join(' · ');
}
