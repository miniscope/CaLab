import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(resolve(import.meta.dirname, rel), 'utf8');

/** Declarations (`--name: value`) of the first block opened by `selector`, in order. */
function block(css: string, selector: string): string[] {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`no block ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css
    .slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(';')
    .map((d) => d.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

const names = (decls: string[]) => decls.map((d) => d.split(':')[0]);

describe('dark theme token sets', () => {
  it('the OS-preference block equals the explicit data-theme block', () => {
    const css = read('../styles/tokens.css');
    const media = block(css, ':root:not([data-theme])');
    const explicit = block(css, ":root[data-theme='dark']");
    expect(media.length).toBeGreaterThan(0);
    expect(media).toEqual(explicit);
  });

  it('redefines only tokens the light set declares', () => {
    const css = read('../styles/tokens.css');
    const light = new Set(names(block(css, ':root {')));
    for (const n of names(block(css, ":root[data-theme='dark']"))) {
      if (n === 'color-scheme') continue;
      expect(light.has(n), n).toBe(true);
    }
  });
});
