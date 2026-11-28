import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BG_SETTLE_GROUND, IDLE_COLOR, KIND_COLOR } from '../lib/work-meter.ts';

const css = readFileSync(resolve(import.meta.dirname, '../styles/global.css'), 'utf8');
const tokens = readFileSync(
  resolve(import.meta.dirname, '../../../../packages/ui/src/styles/tokens.css'),
  'utf8',
);

/** Declarations of the first block opened by `selector`, comments dropped. */
function block(src: string, selector: string): string[] {
  const open = src.indexOf('{', src.indexOf(selector));
  return src
    .slice(open + 1, src.indexOf('}', open))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(';')
    .map((d) => d.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

describe('cala theme tokens', () => {
  it('the OS-preference dark block equals the explicit data-theme block', () => {
    const media = block(css, ':root:not([data-theme])');
    expect(media.length).toBeGreaterThan(0);
    expect(media).toEqual(block(css, ":root[data-theme='dark']"));
  });

  it('every kind colour is a token with a light and a dark value', () => {
    const light = block(css, ':root {').join(';') + block(tokens, ':root {').join(';');
    const dark =
      block(css, ":root[data-theme='dark']").join(';') +
      block(tokens, ":root[data-theme='dark']").join(';');
    for (const c of [...Object.values(KIND_COLOR), IDLE_COLOR, BG_SETTLE_GROUND]) {
      const name = /^var\((--[\w-]+)\)$/.exec(c)?.[1];
      expect(name, c).toBeDefined();
      expect(light).toContain(`${name}:`);
      expect(dark).toContain(`${name}:`);
    }
  });
});
