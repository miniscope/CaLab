#!/usr/bin/env node
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist/CaLab');

mkdirSync(out, { recursive: true });
cpSync(resolve(root, 'apps/catune/dist'), resolve(out, 'catune'), { recursive: true });
cpSync(resolve(root, 'apps/carank/dist'), resolve(out, 'carank'), { recursive: true });

writeFileSync(
  resolve(out, 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CaLab</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 80px auto; color: #1a1a1a; }
    a { color: #2171b5; }
    ul { list-style: none; padding: 0; }
    li { margin: 12px 0; }
  </style>
</head>
<body>
  <h1>CaLab</h1>
  <p>Calcium imaging analysis tools</p>
  <ul>
    <li><a href="catune/">CaTune</a> — Deconvolution parameter tuning</li>
    <li><a href="carank/">CaRank</a> — Trace quality ranking</li>
  </ul>
</body>
</html>
`,
);

console.log('Combined dist created at dist/CaLab/');
