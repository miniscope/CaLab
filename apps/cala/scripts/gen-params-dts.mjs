#!/usr/bin/env node
/**
 * Writes `apps/cala/src/params/cala-params.d.ts` from the params schema
 * (`crates/cala/schema/cala-params.schema.json`). Part of `npm run gen:params`.
 *
 * `--stdout` prints the file instead of writing it (the vitest drift test
 * compares that with the checked-in file).
 *
 * The schema uses a small subset of JSON Schema (objects, `$ref` / `$defs`,
 * `type` arrays for nullable values, `anyOf`, `oneOf` of `const`, `enum`,
 * arrays), so this converter handles exactly that subset and throws on
 * anything else instead of emitting a loose type.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCHEMA = join(repoRoot, 'crates/cala/schema/cala-params.schema.json');
const OUT = join(repoRoot, 'apps/cala/src/params/cala-params.d.ts');

/** A TS doc comment from a schema description (and its unit, when it has one). */
function doc(s, indent = '') {
  const lines = [];
  if (s.description) lines.push(...s.description.split('\n'));
  const unit = s['x-unit'];
  if (unit && unit !== 'none') lines.push(`Unit: ${unit}.`);
  if (lines.length === 0) return '';
  const body = lines.map((l) => `${indent} * ${l}`.trimEnd()).join('\n');
  return `${indent}/**\n${body}\n${indent} */\n`;
}

/** The TS type of a (non-object-definition) schema. */
function typeOf(s) {
  if (s.$ref) return s.$ref.replace('#/$defs/', '');
  if (s.anyOf) return s.anyOf.map(typeOf).join(' | ');
  if (s.oneOf) return s.oneOf.map(typeOf).join(' | ');
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
        case 'array':
          return `${typeOf(s.items)}[]`;
        default:
          throw new Error(`unsupported schema type ${JSON.stringify(t)}`);
      }
    })
    .join(' | ');
}

/** An interface for an object schema. */
function iface(name, s) {
  const required = new Set(s.required ?? []);
  const props = Object.entries(s.properties ?? {})
    .map(([key, p]) => {
      // Fields with a default may be left out of a stored layer; the resolved
      // params always hold every field, so the interface lists them all as set.
      const opt = required.has(key) || 'default' in p ? '' : '?';
      const t = p.enum && p.type ? typeOf({ enum: p.enum }) : typeOf(p);
      return `${doc(p, '  ')}  ${key}${opt}: ${t};`;
    })
    .join('\n');
  return `${doc(s)}export interface ${name} {\n${props}\n}\n`;
}

/** The `.d.ts` text for `schema`, formatted with the repo's prettier config. */
export async function paramsDts(schema) {
  const parts = [
    '// Generated from crates/cala/schema/cala-params.schema.json by `npm run gen:params`.',
    '// Do not edit: change the Rust structs in crates/cala/src/params and regenerate.',
    '',
    `/** The params layout version this file describes. */`,
    `export type CalaParamsVersion = ${schema['x-params-version']};`,
    '',
    iface('CalaParams', schema),
  ];
  for (const [name, def] of Object.entries(schema.$defs ?? {})) {
    if (def.type === 'object') parts.push(iface(name, def));
    else parts.push(`${doc(def)}export type ${name} = ${typeOf(def)};\n`);
  }
  const options = (await prettier.resolveConfig(OUT)) ?? {};
  return prettier.format(parts.join('\n'), { ...options, parser: 'typescript' });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const text = await paramsDts(JSON.parse(readFileSync(SCHEMA, 'utf8')));
  if (process.argv.includes('--stdout')) process.stdout.write(text);
  else {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT}`);
  }
}
