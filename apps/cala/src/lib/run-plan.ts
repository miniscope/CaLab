/**
 * A run plan (project view): sessions put into groups, each a Joint chain
 * (one library through its sessions) or a set of Separate runs, run one group
 * after another. Each group is one run in the project index. The plan stops
 * at a group that stops (a stage failed or was cancelled); what earlier
 * groups, and that group, already wrote is kept.
 */
import type { LibraryMode } from './session-run.ts';

export type GroupKind = Extract<LibraryMode, 'joint' | 'separate'>;

export interface PlanGroup {
  kind: GroupKind;
  /** Session ids, in run order. */
  sessions: string[];
}

/**
 * Add a group of `ids`, ordered as in `order` (the table's order). A session
 * is in one group at most: it leaves the group it was in, and groups left
 * empty go. A one-session chain is a Separate run.
 */
export function addGroup(
  plan: readonly PlanGroup[],
  kind: GroupKind,
  ids: readonly string[],
  order: readonly string[],
): PlanGroup[] {
  const pick = new Set(ids);
  if (pick.size === 0) return [...plan];
  const sessions = order.filter((id) => pick.has(id));
  for (const id of ids) if (!sessions.includes(id)) sessions.push(id);
  const rest = plan
    .map((g) => ({ ...g, sessions: g.sessions.filter((id) => !pick.has(id)) }))
    .filter((g) => g.sessions.length > 0)
    .map((g) =>
      g.kind === 'joint' && g.sessions.length === 1 ? { ...g, kind: 'separate' as const } : g,
    );
  return [...rest, { kind: sessions.length === 1 ? 'separate' : kind, sessions }];
}

export function removeGroup(plan: readonly PlanGroup[], index: number): PlanGroup[] {
  return plan.filter((_, i) => i !== index);
}

export function moveGroup(plan: readonly PlanGroup[], from: number, to: number): PlanGroup[] {
  const out = [...plan];
  if (from < 0 || from >= out.length) return out;
  const [g] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, g);
  return out;
}

/** Where a running plan is. */
export type PlanState =
  | { kind: 'idle' }
  | { kind: 'running'; group: number }
  | { kind: 'done' }
  | { kind: 'stopped'; group: number; reason: string };

/** After group `group` ended: the next state. */
export function afterGroup(
  groups: number,
  group: number,
  outcome: { finished: true } | { stopped: string },
): PlanState {
  if ('stopped' in outcome) return { kind: 'stopped', group, reason: outcome.stopped };
  return group + 1 < groups ? { kind: 'running', group: group + 1 } : { kind: 'done' };
}

export function planSummary(plan: readonly PlanGroup[]): string {
  const n = plan.reduce((k, g) => k + g.sessions.length, 0);
  return `${plan.length} ${plan.length === 1 ? 'group' : 'groups'}, ${n} ${n === 1 ? 'session' : 'sessions'}`;
}
