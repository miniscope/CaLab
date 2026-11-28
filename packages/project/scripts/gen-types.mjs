#!/usr/bin/env node
/**
 * Writes `packages/project/src/generated/files.d.ts` from the envelope schemas
 * (`src/schema/calab-{project,run,index}.schema.json`): `npm run gen:types -w packages/project`.
 *
 * `--stdout` prints the file instead of writing it (the vitest drift test compares that with
 * the checked-in file).
 *
 * The schemas use a small subset of JSON Schema (objects, `$ref` / `$defs`, `type` arrays for
 * nullable values, `anyOf`, `const`, `enum`, arrays, `additionalProperties` maps), so this
 * converter handles exactly that subset and throws on anything else.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMAS = ['calab-project', 'calab-run', 'calab-index'].map((n) =>
  join(pkg, 'src/schema', `${n}.schema.json`),
);
const OUT = join(pkg, 'src/generated/files.d.ts');

function doc(s, indent = '') {
  if (!s.description) return '';
  const body = s.description
    .replaceAll('*/', '*\\/')
    .split('\n')
    .map((l) => `${indent} * ${l}`.trimEnd())
    .join('\n');
  return `${indent}/**\n${body}\n${indent} */\n`;
}

function objectType(s, indent) {
  if (s.properties) return `{\n${props(s, `${indent}  `)}${indent}}`;
  if (s.additionalProperties && typeof s.additionalProperties === 'object')
    return `Record<string, ${typeOf(s.additionalProperties, indent)}>`;
  return 'Record<string, unknown>';
}

function typeOf(s, indent = '') {
  if (s.$ref) return s.$ref.replace('#/$defs/', '');
  if (s.anyOf) return s.anyOf.map((x) => typeOf(x, indent)).join(' | ');
  if ('const' in s) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  const types = Array.isArray(s.type) ? s.type : [s.type];
  return types
    .map((t) => {
      switch (t) {
        case 'number':
        case 'integer':
          return 'number';
        case 'string':
          return 'string';
        case 'boolean':
          return 'boolean';
        case 'null':
          return 'null';
        case 'object':
          return objectType(s, indent);
        case 'array':
          return `${typeOf(s.items, indent)}[]`;
        default:
          throw new Error(`unsupported schema type ${JSON.stringify(t)}`);
      }
    })
    .join(' | ');
}

/** Properties of an object schema; `additionalProperties: true` adds an index signature. */
function props(s, indent) {
  const required = new Set(s.required ?? []);
  const open = s.additionalProperties === true ? `${indent}[key: string]: unknown;\n` : '';
  return (
    Object.entries(s.properties)
      .map(([key, p]) => {
        const opt = required.has(key) ? '' : '?';
        return `${doc(p, indent)}${indent}${key}${opt}: ${typeOf(p, indent)};\n`;
      })
      .join('') + open
  );
}

function named(name, s) {
  if (s.type === 'object' && s.properties)
    return `${doc(s)}export interface ${name} {\n${props(s, '  ')}}\n`;
  return `${doc(s)}export type ${name} = ${typeOf(s)};\n`;
}

/** The `.d.ts` text for the schemas, formatted with the repo's prettier config. */
export async function filesDts(schemas) {
  const parts = [
    '// Generated from packages/project/src/schema/*.schema.json by `npm run gen:types -w packages/project`.',
    '// Do not edit: change the schema and regenerate.',
    '',
  ];
  const seen = new Set();
  for (const schema of schemas) {
    parts.push(named(schema.title, schema));
    for (const [name, def] of Object.entries(schema.$defs ?? {})) {
      if (seen.has(name)) throw new Error(`$defs name ${name} is used twice`);
      seen.add(name);
      parts.push(named(name, def));
    }
  }
  const options = (await prettier.resolveConfig(OUT)) ?? {};
  return prettier.format(parts.join('\n'), { ...options, parser: 'typescript' });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const text = await filesDts(SCHEMAS.map((p) => JSON.parse(readFileSync(p, 'utf8'))));
  if (process.argv.includes('--stdout')) process.stdout.write(text);
  else {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT}`);
  }
}
