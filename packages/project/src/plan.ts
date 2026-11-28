/**
 * The plan of a project file: steps of intent ("run this app on these streams this way"), run
 * one after another. Each step becomes one run, with one library. A step leaves the plan when its
 * run finishes (the run file keeps a copy of it); a stopped plan keeps its remaining steps, so a
 * reload does not lose them.
 */
import type { Plan, PlanStep } from './generated/files';

export type StepKind = PlanStep['kind'];

/** The next unused step id: `a` .. `z`, then `aa`, `ab`, ... */
export function nextStepId(steps: readonly Pick<PlanStep, 'id'>[]): string {
  const taken = new Set(steps.map((s) => s.id));
  for (let n = 0; ; n++) {
    let id = '';
    for (let k = n; ; k = Math.floor(k / 26) - 1) {
      id = String.fromCharCode(97 + (k % 26)) + id;
      if (k < 26) break;
    }
    if (!taken.has(id)) return id;
  }
}

/**
 * Add steps for `refs` (ordered as in `order`, the table's order). `separate` makes one step per
 * stream; `joint` makes one step through all of them (a single stream is a Separate step). A
 * stream is in one pending step at most: it leaves the step it was in, and steps left empty go.
 * Steps that are running are not touched.
 */
export function addSteps(
  plan: Plan,
  app: string,
  kind: Exclude<StepKind, 'apply'>,
  refs: readonly string[],
  order: readonly string[],
): Plan {
  const pick = new Set(refs);
  if (pick.size === 0) return plan;
  const streams = order.filter((r) => pick.has(r));
  for (const r of refs) if (!streams.includes(r)) streams.push(r);
  const kept = plan.steps
    .map((s) =>
      s.status === 'running' ? s : { ...s, streams: s.streams.filter((r) => !pick.has(r)) },
    )
    .filter((s) => s.streams.length > 0)
    .map((s) =>
      s.kind === 'joint' && s.streams.length === 1 ? { ...s, kind: 'separate' as const } : s,
    );
  const out = [...kept];
  const groups = kind === 'joint' && streams.length > 1 ? [streams] : streams.map((r) => [r]);
  for (const g of groups)
    out.push({
      id: nextStepId(out),
      app,
      kind: g.length > 1 ? 'joint' : 'separate',
      streams: g,
      status: 'pending',
      runs: [],
    });
  return { ...plan, steps: out };
}

/** The plan without step `id`. */
export function removeStep(plan: Plan, id: string): Plan {
  return { ...plan, steps: plan.steps.filter((s) => s.id !== id) };
}

/** Step `id` moved to position `to` (clamped). */
export function moveStep(plan: Plan, id: string, to: number): Plan {
  const steps = [...plan.steps];
  const from = steps.findIndex((s) => s.id === id);
  if (from < 0) return plan;
  const [s] = steps.splice(from, 1);
  steps.splice(Math.max(0, Math.min(steps.length, to)), 0, s);
  return { ...plan, steps };
}

/** The steps that can start: those not running, in order. */
export function runnableSteps(plan: Plan): PlanStep[] {
  return plan.steps.filter((s) => s.status !== 'running');
}

/** Step `id` has started run `runId`. */
export function stepStarted(plan: Plan, id: string, runId: string): Plan {
  return {
    ...plan,
    steps: plan.steps.map((s) =>
      s.id === id ? { ...s, status: 'running', runs: [...s.runs, runId] } : s,
    ),
  };
}

/** Step `id`'s run finished: the step leaves the plan. */
export function stepFinished(plan: Plan, id: string): Plan {
  return removeStep(plan, id);
}

/** Step `id`'s run stopped: the step stays, marked stopped, to start again. */
export function stepStopped(plan: Plan, id: string): Plan {
  return {
    ...plan,
    steps: plan.steps.map((s) => (s.id === id ? { ...s, status: 'stopped' } : s)),
  };
}

/** Where a running plan is: the index into the steps it started with. */
export type PlanState =
  | { kind: 'idle' }
  | { kind: 'running'; step: number }
  | { kind: 'done' }
  | { kind: 'stopped'; step: number; reason: string };

/** After step `step` of `steps` ended: the next state. */
export function afterStep(
  steps: number,
  step: number,
  outcome: { finished: true } | { stopped: string },
): PlanState {
  if ('stopped' in outcome) return { kind: 'stopped', step, reason: outcome.stopped };
  return step + 1 < steps ? { kind: 'running', step: step + 1 } : { kind: 'done' };
}

/** "2 steps, 3 streams". */
export function planSummary(steps: readonly PlanStep[]): string {
  const n = steps.reduce((k, s) => k + s.streams.length, 0);
  return `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}, ${n} ${n === 1 ? 'session' : 'sessions'}`;
}
