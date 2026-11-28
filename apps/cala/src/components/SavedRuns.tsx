/**
 * Run files kept in browser storage from runs that never ended: without the File
 * System Access API a run's zip downloads only when the run ends, so a crash or a closed tab
 * would lose its run file. The next open of the project offers each kept file.
 */
import { For, Show, type JSX } from 'solid-js';
import type { ProjectStore } from '../lib/project-store.ts';

/** One line per kept run file, with Download run file and Forget (nothing when there is none). */
export function SavedRuns(props: { project: ProjectStore }): JSX.Element {
  return (
    <Show when={props.project.savedRuns().length > 0}>
      <For each={props.project.savedRuns()}>
        {(r) => (
          <p class="cala-sessions__warning" data-testid="saved-run" role="status">
            Run {r.id} did not finish (the tab closed or the browser stopped). Its run file was
            saved in browser storage.{' '}
            <button
              type="button"
              class="btn-secondary btn-small"
              data-testid="saved-run-download"
              onClick={() => props.project.downloadSavedRun(r.id)}
            >
              Download run file
            </button>{' '}
            <button
              type="button"
              class="btn-secondary btn-small"
              onClick={() => void props.project.forgetSavedRun(r.id)}
            >
              Forget
            </button>
          </p>
        )}
      </For>
    </Show>
  );
}
