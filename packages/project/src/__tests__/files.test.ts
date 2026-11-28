import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkFile,
  fileText,
  readDoc,
  readIndexFile,
  readProjectFile,
  readRunFile,
  readText,
} from '../files.ts';
import { migrateEnvelope, type Migrations } from '../migrate.ts';
import { emptyIndex, rebuildIndex } from '../run-index.ts';
import { describeErrors, validate } from '../json-schema.ts';
import { calaRun, cadeconRun, DAY1, DAY2, T0, threeSessionProject } from './fixtures.ts';

const pkg = join(__dirname, '..', '..');

describe('the three files round-trip', () => {
  it('a project file', () => {
    const p = threeSessionProject();
    const r = readProjectFile(fileText('project', p));
    expect(r).toEqual({ ok: true, value: p, migratedFrom: null });
  });

  it('a run file, of cala and of another app', () => {
    for (const run of [
      calaRun('r1_cala', [DAY1, DAY2], '2026-11-28T09:14:03.000Z'),
      cadeconRun('r2_cadecon', 'r1_cala', DAY1),
    ]) {
      const r = readRunFile(fileText('run', run));
      expect(r.ok && r.value).toEqual(run);
    }
  });

  it('an index file', () => {
    const idx = rebuildIndex(
      [{ folder: 'runs/r1_cala', run: calaRun('r1_cala', [DAY1], '2026-11-28T09:14:03.000Z') }],
      [],
      T0,
    );
    const r = readIndexFile(fileText('index', idx));
    expect(r.ok && r.value).toEqual(idx);
  });

  it('keeps keys it does not know (a newer minor build wrote them)', () => {
    const p = { ...threeSessionProject(), extra: { note: 'kept' } };
    const r = readDoc('project', JSON.parse(JSON.stringify(p)));
    expect(r.ok && (r.value as unknown as typeof p).extra).toEqual({ note: 'kept' });
  });

  it('accepts comments in a hand-edited project file', () => {
    const text = `// mouse 1\n${fileText('project', threeSessionProject())}`;
    expect(readText('project', text).ok).toBe(true);
  });
});

describe('refusals', () => {
  it('refuses the formats of an older cala, by name', () => {
    for (const format of ['cala-project', 'cala-run', 'cala-session', 'cala-run-record']) {
      const r = readRunFile(JSON.stringify({ format, schema_version: 1 }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('old-format');
        expect(r.error).toContain(format);
        expect(r.error).toContain('older cala');
      }
    }
  });

  it('refuses another format, a newer version, bad JSON and a broken file', () => {
    const other = readProjectFile(
      fileText('run', calaRun('r', [DAY1], '2026-11-28T09:14:03.000Z')),
    );
    expect(!other.ok && other.reason).toBe('other-format');
    const newer = readProjectFile(JSON.stringify({ ...threeSessionProject(), version: 2 }));
    expect(!newer.ok && newer.reason).toBe('newer');
    expect(!newer.ok && newer.error).toContain('version 2');
    const json = readIndexFile('{ not json');
    expect(!json.ok && json.reason).toBe('json');
    const noVersion = readIndexFile(JSON.stringify({ format: 'calab-index' }));
    expect(!noVersion.ok && noVersion.reason).toBe('invalid');
    expect(readDoc('index', [1, 2]).ok).toBe(false);
    const broken = {
      ...threeSessionProject(),
      plan: {
        id: null,
        steps: [
          { id: 'a', app: 'cala', kind: 'sideways', streams: [], status: 'pending', runs: [] },
        ],
      },
    };
    const r = readDoc('project', broken);
    expect(!r.ok && r.reason).toBe('invalid');
    expect(!r.ok && r.error).toContain('/plan/steps/0/kind must be one of');
    expect(!r.ok && r.error).toContain('/plan/steps/0/streams must have at least 1 items');
  });

  it('never writes a document that breaks its schema', () => {
    const bad = { ...threeSessionProject(), sessions: 'none' } as never;
    expect(() => fileText('project', bad)).toThrow(/Refusing to write calab-project.json/);
  });
});

describe('migrations', () => {
  const made: Migrations = {
    project: { 0: (d) => ({ ...d, identity: d.cell_matches ?? [], cell_matches: undefined }) },
    run: {},
    index: {},
  };

  it('runs a made-up version 0 -> 1 migration on read', () => {
    const { identity, ...rest } = threeSessionProject();
    const v0 = { ...rest, version: 0, cell_matches: identity };
    const r = readDoc('project', JSON.parse(JSON.stringify(v0)), made);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.migratedFrom).toBe(0);
      expect(r.value.version).toBe(1);
      expect(r.value.identity).toEqual([]);
    }
  });

  it('reports a missing step instead of reading the file as current', () => {
    const r = readDoc('run', { ...calaRun('r', [DAY1], '2026-11-28T09:14:03.000Z'), version: 0 });
    expect(!r.ok && r.error).toContain('no migration of run files from version 0');
    expect(() => migrateEnvelope('index', { version: 1 }, made, 3)).toThrow(/version 1/);
  });
});

describe('schemas', () => {
  it('validate the nullable, map and tuple shapes', () => {
    const run = calaRun('r', [DAY1], '2026-11-28T09:14:03.000Z');
    expect(checkFile('run', run)).toEqual([]);
    const errs = checkFile('run', {
      ...run,
      results: [{ ...run.results[0], frame_range: [1], cells: 1.5 }],
      config: { ...run.config, sources: { '/a': 3 } },
    });
    const text = describeErrors(errs);
    expect(text).toContain('/results/0/frame_range must have at least 2 items');
    expect(text).toContain('/results/0/cells must be integer or null, not number');
    expect(text).toContain('/config/sources/~1a must be string, not integer');
    expect(describeErrors(errs, 1)).toMatch(/and \d+ more$/);
    expect(checkFile('index', { ...emptyIndex(T0), version: 0 })[0].message).toBe(
      'must be at least 1',
    );
  });

  it('throw on a keyword outside the subset, or a $ref that does not resolve', () => {
    expect(() => validate({ pattern: 'x' }, 'a')).toThrow(/not supported/);
    expect(() => validate({ $ref: '#/$defs/Nope' }, 'a')).toThrow(/unresolved/);
    expect(validate({ const: 'a' }, 'b')[0].message).toBe('must be "a"');
    expect(validate({ type: 'array', maxItems: 1 }, [1, 2])[0].message).toBe(
      'must have at most 1 items',
    );
  });

  it('match the checked-in TS types (npm run gen:types)', () => {
    const fresh = execFileSync('node', [join(pkg, 'scripts/gen-types.mjs'), '--stdout'], {
      encoding: 'utf8',
    });
    expect(fresh).toBe(readFileSync(join(pkg, 'src/generated/files.d.ts'), 'utf8'));
  });

  it('describe every key the TS types list, required where the type requires it', () => {
    // The generated file is the schema's TS image: a required schema key is a required TS key.
    const dts = readFileSync(join(pkg, 'src/generated/files.d.ts'), 'utf8');
    for (const name of ['calab-project', 'calab-run', 'calab-index']) {
      const schema = JSON.parse(readFileSync(join(pkg, `src/schema/${name}.schema.json`), 'utf8'));
      expect(dts).toContain(`export interface ${schema.title} {`);
      for (const key of schema.required) expect(dts).toMatch(new RegExp(`\\n  ${key}: `));
    }
  });
});
