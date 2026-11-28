/**
 * Links: typed edges from a run to what earlier runs made (`seed`, `library`, `traces`,
 * `config`). They are stored in the consuming run's file, so provenance reads backwards from any
 * run; the index answers the forward questions (who used this run, which links went stale).
 */
import type { IndexFile, ProjectFile, RunLink, StepLink } from './generated/files';
import { currentResult } from './run-index.ts';

export type LinkRole = RunLink['role'];
export const LINK_ROLES: readonly LinkRole[] = ['seed', 'library', 'traces', 'config'];

/**
 * A plan step's link as a run link: a pointer to an earlier step becomes that step's run once
 * it has run. Throws when the step has no run yet or the link names neither.
 */
export function resolveStepLink(link: StepLink, stepRuns: ReadonlyMap<string, string>): RunLink {
  const { step, ...rest } = link;
  const run = link.run ?? (step !== undefined ? stepRuns.get(step) : undefined);
  if (run === undefined)
    throw new Error(
      step !== undefined ? `step ${step} has not run yet` : 'a link names no run and no step',
    );
  return { ...rest, role: link.role, run, stream: link.stream ?? null };
}

/** Links of the index's runs whose target run is not in the index. */
export function brokenLinks(
  index: IndexFile,
): { run: string; link: IndexFile['runs'][number]['links'][number] }[] {
  const ids = new Set(index.runs.map((r) => r.id));
  return index.runs.flatMap((r) =>
    r.links.filter((l) => !ids.has(l.run)).map((link) => ({ run: r.id, link })),
  );
}

/** The runs that link to run `id`. */
export function linkedFrom(index: IndexFile, id: string): string[] {
  return index.runs.filter((r) => r.links.some((l) => l.run === id)).map((r) => r.id);
}

/**
 * Links of run `id` to a result that is no longer the current result of its app for that stream
 * (e.g. a CaDecon run made from a cala result that a newer cala run replaced).
 */
export function staleLinks(
  index: IndexFile,
  current: ProjectFile['current'],
  id: string,
): IndexFile['runs'][number]['links'] {
  const run = index.runs.find((r) => r.id === id);
  if (!run) return [];
  return run.links.filter((l) => {
    const target = index.runs.find((r) => r.id === l.run);
    if (l.stream === null || !target) return false;
    const cur = currentResult(index, current, target.app, l.stream);
    return cur !== null && cur.run !== l.run;
  });
}
