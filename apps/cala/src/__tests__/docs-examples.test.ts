// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readText, type FileKind } from '@calab/project';

/** The JSON examples of `docs/projects.md` are files `@calab/project` reads as they are. */
const KINDS: Record<string, FileKind> = {
  'calab-project': 'project',
  'calab-run': 'run',
  'calab-index': 'index',
};

describe('docs/projects.md examples', () => {
  const md = readFileSync(resolve(import.meta.dirname, '../../docs/projects.md'), 'utf8');
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);

  it('has an example of the project file', () => {
    expect(blocks.some((b) => b.includes('"format": "calab-project"'))).toBe(true);
  });

  it.each(blocks.map((b, i) => [i, b] as const))('block %i passes its schema', (_, text) => {
    const format = (JSON.parse(text) as { format: string }).format;
    const kind = KINDS[format];
    expect(kind).toBeDefined();
    const r = readText(kind, text);
    expect(r.ok ? null : r.error).toBeNull();
  });
});
