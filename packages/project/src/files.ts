/**
 * Reading, checking and writing the three envelope files as text. A read never guesses: a file
 * of an old format, of another format, of a newer version or that breaks its schema comes back
 * as a refusal with the reason. An older version is migrated in memory (`migrate.ts`).
 */
import { parseJsonWithComments } from '@calab/core';
import type { IndexFile, ProjectFile, RunFile } from './generated/files';
import {
  FILE_NAMES,
  FORMATS,
  OLD_FORMATS,
  VERSIONS,
  oldFormatMessage,
  type FileKind,
} from './formats.ts';
import { describeErrors, validate, type SchemaError, type SchemaNode } from './json-schema.ts';
import { ENVELOPE_MIGRATIONS, migrateEnvelope, type Migrations } from './migrate.ts';
import projectSchema from './schema/calab-project.schema.json';
import runSchema from './schema/calab-run.schema.json';
import indexSchema from './schema/calab-index.schema.json';

/** The JSON Schema of each file. */
export const SCHEMAS: Record<FileKind, SchemaNode> = {
  project: projectSchema as SchemaNode,
  run: runSchema as SchemaNode,
  index: indexSchema as SchemaNode,
};

interface Docs {
  project: ProjectFile;
  run: RunFile;
  index: IndexFile;
}

/** Why a file was not read. */
export type RefusalReason = 'json' | 'old-format' | 'other-format' | 'newer' | 'invalid';

export type ReadResult<T> =
  | {
      ok: true;
      value: T;
      /** The version the file had when it was older than this build's (migrated in memory). */
      migratedFrom: number | null;
    }
  | { ok: false; reason: RefusalReason; error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The schema errors of a document of `kind` (empty: valid). */
export function checkFile(kind: FileKind, doc: unknown): SchemaError[] {
  return validate(SCHEMAS[kind], doc);
}

/** Read a parsed document of `kind`. */
export function readDoc<K extends FileKind>(
  kind: K,
  json: unknown,
  migrations: Migrations = ENVELOPE_MIGRATIONS,
): ReadResult<Docs[K]> {
  const name = FILE_NAMES[kind];
  if (!isObj(json)) return { ok: false, reason: 'invalid', error: `${name} is not a JSON object` };
  const format = json.format;
  if (typeof format === 'string' && OLD_FORMATS.includes(format))
    return { ok: false, reason: 'old-format', error: oldFormatMessage(`This file ("${format}")`) };
  if (format !== FORMATS[kind])
    return {
      ok: false,
      reason: 'other-format',
      error: `not a ${FORMATS[kind]} file (format ${JSON.stringify(format ?? null)})`,
    };
  const v = json.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
    return { ok: false, reason: 'invalid', error: `${name} has no version` };
  if (v > VERSIONS[kind])
    return {
      ok: false,
      reason: 'newer',
      error: `${name} is version ${v}, newer than this app's ${VERSIONS[kind]}`,
    };
  let doc: Record<string, unknown> = json;
  if (v < VERSIONS[kind]) {
    try {
      doc = migrateEnvelope(kind, json, migrations);
    } catch (err) {
      return {
        ok: false,
        reason: 'invalid',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  const errors = checkFile(kind, doc);
  if (errors.length > 0)
    return { ok: false, reason: 'invalid', error: `${name}: ${describeErrors(errors)}` };
  return {
    ok: true,
    value: doc as unknown as Docs[K],
    migratedFrom: v < VERSIONS[kind] ? v : null,
  };
}

/** Read the text of a file of `kind` (`//` and block comments are accepted). */
export function readText<K extends FileKind>(
  kind: K,
  text: string,
  migrations?: Migrations,
): ReadResult<Docs[K]> {
  let json: unknown;
  try {
    json = parseJsonWithComments(text);
  } catch (err) {
    return {
      ok: false,
      reason: 'json',
      error: `${FILE_NAMES[kind]} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  return readDoc(kind, json, migrations);
}

export const readProjectFile = (text: string) => readText('project', text);
export const readRunFile = (text: string) => readText('run', text);
export const readIndexFile = (text: string) => readText('index', text);

/**
 * The text of a document of `kind`: checked against its schema (a broken document is a bug in
 * the writer and throws), 2-space JSON with a final newline.
 */
export function fileText(kind: FileKind, doc: ProjectFile | RunFile | IndexFile): string {
  const errors = checkFile(kind, doc);
  if (errors.length > 0)
    throw new Error(`Refusing to write ${FILE_NAMES[kind]}: ${describeErrors(errors)}`);
  return `${JSON.stringify(doc, null, 2)}\n`;
}
