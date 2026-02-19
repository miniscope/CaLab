#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const appsDir = resolve(root, 'apps');
const out = resolve(root, 'dist/CaLab');

mkdirSync(out, { recursive: true });

const statusOrder = { stable: 0, beta: 1, 'coming-soon': 2 };

const apps = readdirSync(appsDir)
  .filter((name) => {
    if (name === '_template') return false;
    const dir = join(appsDir, name);
    if (!statSync(dir).isDirectory()) return false;
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
      return pkg.calab?.displayName != null;
    } catch {
      return false;
    }
  })
  .map((name) => {
    const pkg = JSON.parse(readFileSync(join(appsDir, name, 'package.json'), 'utf-8'));
    const screenshot = pkg.calab.screenshot ?? '';
    let screenshotFile = '';
    if (screenshot) {
      const screenshotPath = join(appsDir, name, screenshot);
      if (existsSync(screenshotPath)) {
        screenshotFile = `${name}-screenshot.png`;
        cpSync(screenshotPath, join(out, screenshotFile));
      }
    }
    return {
      dir: name,
      displayName: pkg.calab.displayName,
      description: pkg.calab.description ?? '',
      longDescription: pkg.calab.longDescription ?? '',
      features: pkg.calab.features ?? [],
      status: pkg.calab.status ?? 'coming-soon',
      screenshotFile,
    };
  })
  .sort((a, b) => (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99));

for (const app of apps) {
  const src = resolve(appsDir, app.dir, 'dist');
  cpSync(src, resolve(out, app.displayName), { recursive: true });
}

const statusBadge = {
  stable: { label: 'Stable', color: '#2e7d32', bg: 'rgba(46,125,50,0.08)' },
  beta: { label: 'Beta', color: '#e09800', bg: 'rgba(224,152,0,0.08)' },
  'coming-soon': { label: 'Coming Soon', color: '#616161', bg: 'rgba(97,97,97,0.08)' },
};

function renderCard(app) {
  const badge = statusBadge[app.status] ?? statusBadge['coming-soon'];

  const screenshotHtml = app.screenshotFile
    ? `<img class="card-screenshot" src="${app.screenshotFile}" alt="${app.displayName} screenshot" />`
    : '';

  const featuresHtml = app.features.length
    ? `<ul class="features">${app.features.map((f) => `<li>${f}</li>`).join('')}</ul>`
    : '';

  const longDescHtml = app.longDescription ? `<p class="long-desc">${app.longDescription}</p>` : '';

  return `    <a class="card" href="${app.displayName}/">
      ${screenshotHtml}
      <div class="card-header">
        <h2>${app.displayName}</h2>
        <span class="badge" style="color:${badge.color};background:${badge.bg}">${badge.label}</span>
      </div>
      <p class="tagline">${app.description}</p>
      ${longDescHtml}
      ${featuresHtml}
      <span class="cta">Open ${app.displayName} &rarr;</span>
    </a>`;
}

const version = process.env.VITE_APP_VERSION ?? '';
const versionHtml = version ? `<span class="version">v${version}</span> &middot; ` : '';

const cards = apps.map(renderCard).join('\n');

writeFileSync(
  resolve(out, 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CaLab</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #1a1a1a;
      background: #f0f0f0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .page {
      max-width: 900px;
      margin: 0 auto;
      padding: 0 16px;
      width: 100%;
    }

    header {
      padding: 48px 0 32px;
      text-align: center;
    }
    header h1 {
      font-size: 2rem;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    .version-sup {
      font-size: 0.45em;
      font-weight: 400;
      color: #9e9e9e;
      font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
      vertical-align: super;
      margin-left: 4px;
    }

    header .subtitle {
      color: #616161;
      margin-top: 8px;
      font-size: 1.05rem;
    }
    header .github-link {
      display: inline-block;
      margin-top: 12px;
      color: #2171b5;
      text-decoration: none;
      font-size: 0.9rem;
    }
    header .github-link:hover { text-decoration: underline; }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 24px;
      padding-bottom: 48px;
    }

    .card {
      background: #ffffff;
      border: 1px solid #e8e8e8;
      border-radius: 6px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      text-decoration: none;
      color: inherit;
      cursor: pointer;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }

    .card-screenshot {
      width: 100%;
      border-radius: 4px;
      border: 1px solid #e0e0e0;
      margin-bottom: 4px;
    }
    .card:hover {
      border-color: #2171b5;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .card-header h2 {
      font-size: 1.25rem;
      font-weight: 600;
    }

    .badge {
      font-size: 0.75rem;
      font-weight: 500;
      padding: 2px 10px;
      border-radius: 4px;
      white-space: nowrap;
    }

    .tagline {
      color: #616161;
      font-size: 0.95rem;
    }

    .long-desc {
      font-size: 0.9rem;
      line-height: 1.55;
      color: #1a1a1a;
    }

    .features {
      list-style: none;
      border-left: 3px solid #2171b5;
      padding-left: 16px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .features li {
      font-size: 0.85rem;
      color: #1a1a1a;
      line-height: 1.4;
    }

    .cta {
      margin-top: auto;
      padding-top: 4px;
      color: #2171b5;
      text-decoration: none;
      font-weight: 500;
      font-size: 0.9rem;
    }
    .cta:hover { text-decoration: underline; }

    footer {
      margin-top: auto;
      padding: 24px 0;
      text-align: center;
      font-size: 0.8rem;
      color: #9e9e9e;
    }
    footer a { color: #9e9e9e; }
    footer a:hover { color: #616161; }
    .version { font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace; }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <h1>CaLab${version ? `<sup class="version-sup">v${version}</sup>` : ''}</h1>
      <p class="subtitle">Calcium imaging analysis tools</p>
      <a class="github-link" href="https://github.com/miniscope/CaLab">GitHub &rarr;</a>
    </header>
    <div class="grid">
${cards}
    </div>
  </div>
  <footer>
    <div class="page">
      ${versionHtml}<a href="https://github.com/miniscope/CaLab">GitHub</a>
    </div>
  </footer>
</body>
</html>
`,
);

console.log(`Combined dist created at dist/CaLab/ (${apps.length} apps)`);
