/**
 * Envelope migrations: pure functions that take a file of version `v` to `v + 1`, run in order on
 * read. A project file is rewritten at its next save; a run file is never rewritten and is
 * migrated on every read. Params blocks are migrated by their app (`apps.ts`), not here.
 */
import { VERSIONS, type FileKind } from './formats.ts';

/** Takes a document of version `from` to `from + 1` (its `version` field is set by the runner). */
export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** Per file kind: the migration out of each version, keyed by that version. */
export type Migrations = Record<FileKind, Partial<Record<number, Migration>>>;

/** The migrations of this build. Every file is at version 1, so there are none. */
export const ENVELOPE_MIGRATIONS: Migrations = { project: {}, run: {}, index: {} };

/**
 * `doc` (of version `doc.version`) migrated to this build's version of `kind`. Throws when a step
 * is missing, so an unreadable gap is reported rather than read as the current version.
 */
export function migrateEnvelope(
  kind: FileKind,
  doc: Record<string, unknown>,
  migrations: Migrations = ENVELOPE_MIGRATIONS,
  to: number = VERSIONS[kind],
): Record<string, unknown> {
  let out = doc;
  for (let v = Number(doc.version); v < to; v++) {
    const step = migrations[kind][v];
    if (!step) throw new Error(`no migration of ${kind} files from version ${v}`);
    out = { ...step(out), version: v + 1 };
  }
  return out;
}
