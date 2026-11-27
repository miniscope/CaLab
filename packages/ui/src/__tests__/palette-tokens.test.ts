import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STAGE_HUES } from '../palette.ts';

const tokens = readFileSync(resolve(import.meta.dirname, '../styles/tokens.css'), 'utf8');
const token = (name: string): string | undefined =>
  new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(tokens)?.[1]?.toLowerCase();

describe('STAGE_HUES', () => {
  it('equals the --stage-* tokens', () => {
    expect(token('stage-discover')).toBe(STAGE_HUES.discover);
    expect(token('stage-discover-tint')).toBe(STAGE_HUES.discoverTint);
    expect(token('stage-settle')).toBe(STAGE_HUES.settle);
    expect(token('stage-settle-tint')).toBe(STAGE_HUES.settleTint);
    expect(token('stage-extract')).toBe(STAGE_HUES.extract);
    expect(token('stage-extract-tint')).toBe(STAGE_HUES.extractTint);
  });
});
