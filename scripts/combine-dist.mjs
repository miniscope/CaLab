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

// Load .env file (same vars Vite reads for the apps)
const envPath = resolve(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

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
      hidden: pkg.calab.hidden ?? false,
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
const versionHtml = version ? `<span class="version">${version}</span> &middot; ` : '';

// Auth env vars — injected at build time
const supabaseUrl = process.env.VITE_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY ?? '';
const authEnabled = !!(supabaseUrl && supabaseAnonKey);

const cards = apps
  .filter((a) => !a.hidden)
  .map(renderCard)
  .join('\n');

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
      position: relative;
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
    .privacy-notice { margin-bottom: 12px; font-size: 0.75rem; line-height: 1.4; }

    /* Auth menu */
    .auth-landing { position: absolute; top: 16px; right: 16px; }
    .auth-landing__avatar {
      width: 28px; height: 28px; border-radius: 50%; background: #2171b5;
      color: #fff; font-size: 0.8rem; font-weight: 600; display: flex;
      align-items: center; justify-content: center; border: none;
      cursor: pointer; padding: 0; line-height: 1;
    }
    .auth-landing__avatar:hover { background: #185a92; }
    .auth-landing__trigger {
      padding: 4px 12px; border: 1px solid #d4d4d4; border-radius: 4px;
      background: #fff; font-size: 0.8rem; cursor: pointer; color: #1a1a1a;
    }
    .auth-landing__trigger:hover { border-color: #2171b5; }
    .auth-landing__dropdown {
      position: absolute; top: calc(100% + 4px); right: 0; min-width: 240px;
      background: #fff; border: 1px solid #d4d4d4; border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.12); padding: 8px; z-index: 100;
    }
    .auth-landing__email {
      font-size: 0.8rem; font-family: 'JetBrains Mono', 'SF Mono', monospace;
      color: #616161; padding: 4px; margin-bottom: 4px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .auth-landing__signout {
      display: block; width: 100%; padding: 4px; background: none;
      border: 1px solid #d4d4d4; border-radius: 2px; color: #1a1a1a;
      font-size: 0.8rem; cursor: pointer; text-align: center;
    }
    .auth-landing__signout:hover { background: rgba(33,113,181,0.08); }
    .auth-landing__form input {
      width: 100%; padding: 6px 8px; border: 1px solid #d4d4d4;
      border-radius: 2px; font-size: 0.8rem; outline: none; box-sizing: border-box;
    }
    .auth-landing__form button {
      width: 100%; margin-top: 8px; padding: 4px 12px; border: 1px solid #d4d4d4;
      border-radius: 4px; background: #fff; font-size: 0.8rem; cursor: pointer; color: #1a1a1a;
    }
    .auth-landing__form button:hover { border-color: #2171b5; }
    .auth-landing__sent { font-size: 0.8rem; color: #616161; margin: 0; }
    .auth-landing__error { font-size: 0.75rem; color: #d32f2f; margin: 8px 0 0; }

    /* Auth callback page */
    .auth-cb { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .auth-cb__card {
      background: #fff; border: 1px solid #d4d4d4; border-radius: 4px;
      padding: 24px 48px; max-width: 420px; width: 100%; text-align: center;
      box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    }
    .auth-cb__icon { font-size: 2.5rem; color: #2e7d32; line-height: 1; margin-bottom: 8px; }
    .auth-cb__heading { font-size: 1.25rem; color: #1a1a1a; margin: 0 0 8px; font-weight: 600; }
    .auth-cb__text { color: #616161; font-size: 0.9rem; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <h1>CaLab${version ? `<sup class="version-sup">${version}</sup>` : ''}</h1>
      <p class="subtitle">Calcium imaging analysis tools</p>
      <a class="github-link" href="https://github.com/miniscope/CaLab">GitHub &rarr;</a>
      ${authEnabled ? '<div id="auth-menu" class="auth-landing"></div>' : ''}
    </header>
    <div class="grid">
${cards}
    </div>
  </div>
  <footer>
    <div class="page">
      <p class="privacy-notice">CaLab collects anonymous usage statistics to support grant reporting. No personal data or IP addresses are stored.</p>
      ${versionHtml}<a href="https://github.com/miniscope/CaLab">GitHub</a>
    </div>
  </footer>
  ${
    authEnabled
      ? `<script type="module">
    const SUPABASE_URL = '${supabaseUrl}';
    const SUPABASE_ANON_KEY = '${supabaseAnonKey}';
    const container = document.getElementById('auth-menu');
    if (!container) throw new Error('Missing #auth-menu');

    const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
    const storageKey = 'sb-' + ref + '-auth-token';

    let dropdownOpen = false;
    let supabase = null;

    // Auth callback: if URL hash has access_token, show confirmation page
    const hash = window.location.hash;
    if (hash.includes('access_token=') || hash.includes('token_hash=')) {
      const page = document.querySelector('.page');
      page.textContent = '';
      const wrap = document.createElement('div');
      wrap.className = 'auth-cb';
      const card = document.createElement('div');
      card.className = 'auth-cb__card';
      const icon = document.createElement('div');
      icon.className = 'auth-cb__icon';
      icon.textContent = '\\u2713';
      const heading = document.createElement('h2');
      heading.className = 'auth-cb__heading';
      heading.textContent = "You're signed in";
      const text = document.createElement('p');
      text.className = 'auth-cb__text';
      text.textContent = 'You can close this tab and return to the CaLab tab where you requested sign-in.';
      card.append(icon, heading, text);
      wrap.appendChild(card);
      page.appendChild(wrap);
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } else {
      render();
    }

    function getSession() {
      try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return null;
        const data = JSON.parse(raw);
        return data?.user?.email ? data.user.email : null;
      } catch { return null; }
    }

    async function getClient() {
      if (supabase) return supabase;
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      return supabase;
    }

    function render() {
      const email = getSession();
      dropdownOpen = false;
      container.textContent = '';
      if (email) {
        const btn = document.createElement('button');
        btn.className = 'auth-landing__avatar';
        btn.setAttribute('aria-haspopup', 'true');
        btn.textContent = email.charAt(0).toUpperCase();
        btn.onclick = () => toggleDropdown(email);
        container.appendChild(btn);
      } else {
        const btn = document.createElement('button');
        btn.className = 'auth-landing__trigger';
        btn.textContent = 'Sign In';
        btn.onclick = () => toggleSignInDropdown();
        container.appendChild(btn);
      }
    }

    function toggleDropdown(email) {
      if (dropdownOpen) { closeDropdown(); return; }
      dropdownOpen = true;
      const dd = document.createElement('div');
      dd.className = 'auth-landing__dropdown';
      const emailEl = document.createElement('div');
      emailEl.className = 'auth-landing__email';
      emailEl.textContent = email;
      const signOutBtn = document.createElement('button');
      signOutBtn.className = 'auth-landing__signout';
      signOutBtn.textContent = 'Sign Out';
      signOutBtn.onclick = async () => {
        const client = await getClient();
        await client.auth.signOut({ scope: 'local' });
        render();
      };
      dd.append(emailEl, signOutBtn);
      container.appendChild(dd);
      requestAnimationFrame(() => {
        document.addEventListener('pointerdown', outsideClick);
        document.addEventListener('keydown', escClose);
      });
    }

    function toggleSignInDropdown() {
      if (dropdownOpen) { closeDropdown(); return; }
      dropdownOpen = true;
      const dd = document.createElement('div');
      dd.className = 'auth-landing__dropdown';
      const form = document.createElement('div');
      form.className = 'auth-landing__form';
      const input = document.createElement('input');
      input.type = 'email';
      input.placeholder = 'you@lab.edu';
      const btn = document.createElement('button');
      btn.textContent = 'Send Sign-In Link';
      btn.onclick = async () => {
        const addr = input.value.trim();
        if (!addr) return;
        btn.textContent = 'Sending...';
        btn.disabled = true;
        const client = await getClient();
        const { error } = await client.auth.signInWithOtp({
          email: addr,
          options: { emailRedirectTo: window.location.origin + window.location.pathname },
        });
        if (error) {
          dd.querySelector('.auth-landing__error')?.remove();
          const p = document.createElement('p');
          p.className = 'auth-landing__error';
          p.textContent = error.message;
          dd.appendChild(p);
          btn.textContent = 'Send Sign-In Link';
          btn.disabled = false;
        } else {
          dd.textContent = '';
          const sent = document.createElement('p');
          sent.className = 'auth-landing__sent';
          sent.textContent = 'Check your email for a sign-in link.';
          dd.appendChild(sent);
        }
      };
      form.append(input, btn);
      dd.appendChild(form);
      container.appendChild(dd);
      input.focus();
      requestAnimationFrame(() => {
        document.addEventListener('pointerdown', outsideClick);
        document.addEventListener('keydown', escClose);
      });
    }

    function outsideClick(e) {
      if (!container.contains(e.target)) closeDropdown();
    }
    function escClose(e) {
      if (e.key === 'Escape') closeDropdown();
    }
    function closeDropdown() {
      dropdownOpen = false;
      container.querySelector('.auth-landing__dropdown')?.remove();
      document.removeEventListener('pointerdown', outsideClick);
      document.removeEventListener('keydown', escClose);
    }
  </script>`
      : ''
  }
</body>
</html>
`,
);

console.log(`Combined dist created at dist/CaLab/ (${apps.length} apps)`);
