/**
 * Names, format strings and versions of the CaLab project files (`apps/cala/docs/projects.md`).
 * A project folder holds `calab-project.json` (intent), `calab-index.json` (a cache) and one
 * folder per run under `runs/`, each with its `calab-run.json`.
 */

/** The results folder of a project, inside the data folder by default. */
export const PROJECT_DIR = 'calab-project';
export const PROJECT_FILE = 'calab-project.json';
export const RUN_FILE = 'calab-run.json';
export const INDEX_FILE = 'calab-index.json';
/** Run folders: `<project folder>/runs/<run id>/`. */
export const RUNS_DIR = 'runs';
/** Cell-match files: `<project folder>/identity/`. */
export const IDENTITY_DIR = 'identity';

/** The three envelope files. */
export type FileKind = 'project' | 'run' | 'index';

/** The `format` string of each file. */
export const FORMATS = {
  project: 'calab-project',
  run: 'calab-run',
  index: 'calab-index',
} as const satisfies Record<FileKind, string>;

/** The envelope version this build writes, per file. */
export const VERSIONS: Record<FileKind, number> = { project: 1, run: 1, index: 1 };

/** The file name of each kind. */
export const FILE_NAMES: Record<FileKind, string> = {
  project: PROJECT_FILE,
  run: RUN_FILE,
  index: INDEX_FILE,
};

/**
 * Formats written by cala before the CaLab project files. They are never read (there is no
 * migration from them); a reader names them so the user knows why a tree looks empty.
 */
export const OLD_FORMATS: readonly string[] = [
  'cala-project',
  'cala-run',
  'cala-session',
  'cala-run-record',
];
/** The file names of those formats, and the results folder they were written to. */
export const OLD_FILES: readonly string[] = [
  'cala-project.json',
  'cala-run.json',
  'cala-session.json',
  'cala-run-record.json',
];
export const OLD_RESULTS_DIR = 'cala-results';

/** What the user is told about a file or folder of an old format. */
export function oldFormatMessage(what: string): string {
  return `${what} was made by an older cala and is not read. Results now go to ${PROJECT_DIR}/; run the sessions again to make them.`;
}
