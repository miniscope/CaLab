/**
 * The landing page (dist/<repo>/index.html), rendered by combine-dist.
 *
 * It is plain HTML with inline CSS: no bundle, so it loads before any app.
 * Its colours, type, spacing and radii come from the apps' own design tokens,
 * packages/ui/src/styles/tokens.css, inlined at build time, so the page tracks
 * CaTune, CaDecon and Cala instead of keeping a copy of their values.
 *
 * Apps come from discoverApps() (scripts/lib/apps.mjs). Released apps
 * (stable, beta) get a card with a screenshot; coming-soon apps get a short
 * row under "In development". The grid fills by width, so it takes more apps
 * without layout changes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './apps.mjs';

const REPO_URL = 'https://github.com/miniscope/CaLab';
const DOCS_URL = 'https://calab.readthedocs.io';
const PYPI_URL = 'https://pypi.org/project/calab/';
const CHANGELOG_URL = `${REPO_URL}/blob/main/docs/CHANGELOG.md`;
const CITATION_URL = `${REPO_URL}/blob/main/CITATION.cff`;
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
const MINISCOPE_URL = 'https://github.com/miniscope';

const STATUS_LABEL = { stable: 'Stable', beta: 'Beta', 'coming-soon': 'Coming soon' };

/**
 * How the apps chain, keyed by `calab.id`. A step is shown only while its app
 * is listed and released, so removing or hiding an app drops its line.
 */
const WORKFLOW = [
  { app: 'cala', input: 'Raw Miniscope video', output: 'cell footprints and traces' },
  { app: 'cadecon', input: 'Traces', output: 'calcium kernel and spikes, estimated automatically' },
  { app: 'catune', input: 'Traces', output: 'deconvolution parameters, tuned by eye' },
];

/** Escape a string for safe embedding in HTML content/attributes. */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** packages/ui tokens.css, minus comments, for inlining. */
function designTokens() {
  const css = readFileSync(join(repoRoot, 'packages/ui/src/styles/tokens.css'), 'utf-8');
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*\n/g, '\n');
}

function badge(status) {
  const key = STATUS_LABEL[status] ? status : 'coming-soon';
  return `<span class="badge badge--${key}">${STATUS_LABEL[key]}</span>`;
}

function renderCard(app) {
  const href = `${escapeHtml(app.path)}/`;
  const thumb = app.screenshotFile
    ? `<img src="${escapeHtml(app.screenshotFile)}" alt="" decoding="async" />`
    : '';
  return `        <li>
          <a class="card" href="${href}">
            <div class="card__thumb">${thumb}</div>
            <div class="card__body">
              <div class="card__title">
                <h2>${escapeHtml(app.displayName)}</h2>
                ${badge(app.status)}
              </div>
              <p class="card__desc">${escapeHtml(app.description)}</p>
              <span class="card__cta">Open ${escapeHtml(app.displayName)} <span aria-hidden="true">&rarr;</span></span>
            </div>
          </a>
        </li>`;
}

function renderUpcoming(app) {
  return `        <li>
          <a class="upcoming__item" href="${escapeHtml(app.path)}/">
            <h3>${escapeHtml(app.displayName)}</h3>
            ${badge(app.status)}
            <span class="upcoming__desc">${escapeHtml(app.description)}</span>
          </a>
        </li>`;
}

function renderWorkflow(released) {
  const byId = new Map(released.map((a) => [a.id, a]));
  const steps = WORKFLOW.filter((s) => byId.has(s.app)).map((s) => {
    const app = byId.get(s.app);
    return `          <li>
            <a href="${escapeHtml(app.path)}/">${escapeHtml(app.displayName)}</a>
            <span class="flow__io">${escapeHtml(s.input)} <span aria-hidden="true">&rarr;</span><span class="sr-only">in,</span> ${escapeHtml(s.output)}<span class="sr-only"> out</span></span>
          </li>`;
  });
  if (steps.length === 0) return '';
  return `      <section class="flow" aria-labelledby="flow-heading">
        <h2 id="flow-heading">How the apps fit together</h2>
        <ul>
${steps.join('\n')}
        </ul>
        <p class="flow__python">In scripts, the <a href="${DOCS_URL}">Python package</a> runs the same solver: <code>pip install calab</code></p>
      </section>`;
}

/**
 * @param {object} opts
 * @param {Array} opts.apps discoverApps() entries plus `screenshotFile` ('' if none)
 * @param {string} opts.version release name (e.g. v2.13.0), or ''
 * @param {string} opts.supabaseUrl
 * @param {string} opts.supabaseAnonKey
 */
export function renderLandingPage({ apps, version, supabaseUrl, supabaseAnonKey }) {
  const listed = apps.filter((a) => !a.hidden);
  const released = listed.filter((a) => a.status !== 'coming-soon');
  const upcoming = listed.filter((a) => a.status === 'coming-soon');
  const authEnabled = !!(supabaseUrl && supabaseAnonKey);

  const versionText = escapeHtml(version);
  const versionLink = /^v\d/.test(version)
    ? `<a class="version" href="${REPO_URL}/releases/tag/${encodeURIComponent(version)}">${versionText}</a>`
    : version
      ? `<span class="version">${versionText}</span>`
      : '';

  const upcomingHtml = upcoming.length
    ? `
      <section class="upcoming" aria-labelledby="upcoming-heading">
        <h2 id="upcoming-heading">In development</h2>
        <ul>
${upcoming.map(renderUpcoming).join('\n')}
        </ul>
      </section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="description" content="CaLab: browser-based calcium imaging analysis, from raw Miniscope video to cell traces and spikes." />
  <title>CaLab</title>
  <style>
${designTokens()}
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--font-body);
      color: var(--text-primary);
      background: var(--bg-secondary);
      line-height: 1.5;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--accent); }
    a:hover { color: var(--accent-hover); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--radius-sm); }
    code { font-family: var(--font-mono); font-size: 0.85em; }

    .sr-only {
      position: absolute; width: 1px; height: 1px; overflow: hidden;
      clip: rect(0 0 0 0); white-space: nowrap;
    }
    .skip-link {
      position: absolute; left: var(--space-md); top: -48px; z-index: 200;
      background: var(--bg-primary); padding: var(--space-sm) var(--space-md);
      border-radius: var(--radius-md); box-shadow: var(--shadow-elevated);
    }
    .skip-link:focus { top: var(--space-sm); }

    .page {
      max-width: 1120px;
      margin: 0 auto;
      padding: 0 var(--space-lg);
      width: 100%;
    }
    main.page { flex: 1; }

    /* Masthead: a light bar like the apps' compact header */
    .bar { background: var(--bg-primary); border-bottom: 1px solid var(--border-subtle); }
    .bar .page {
      display: flex; align-items: center; gap: var(--space-md);
      min-height: 56px; flex-wrap: wrap;
    }
    .bar h1 {
      font-size: 1.35rem; font-weight: var(--font-weight-semibold);
      letter-spacing: -0.02em; line-height: 1;
    }
    .bar h1 .version-tag {
      font-family: var(--font-mono); font-size: 0.65rem; font-weight: var(--font-weight-normal);
      color: var(--text-secondary); margin-left: 6px; letter-spacing: 0;
    }
    .bar nav { margin-left: auto; }
    .bar nav ul { list-style: none; display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-md); }
    .bar nav a {
      color: var(--text-secondary); text-decoration: none; font-size: 0.9rem;
      transition: color var(--transition-fast);
    }
    .bar nav a:hover { color: var(--accent); }

    /* Intro: what CaLab is, beside how the apps chain */
    .intro {
      display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: var(--space-xl); align-items: start;
      padding: var(--space-xl) 0 var(--space-lg);
    }
    .lede {
      font-size: 1.5rem; line-height: 1.3; letter-spacing: -0.015em;
      font-weight: var(--font-weight-semibold); max-width: 26ch;
    }
    .intro__sub { margin-top: var(--space-sm); color: var(--text-secondary); max-width: 52ch; }

    .flow {
      background: var(--bg-primary); border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg); padding: var(--space-md) var(--space-lg);
      font-size: 0.9rem;
    }
    .flow h2 { font-size: 0.95rem; font-weight: var(--font-weight-semibold); margin-bottom: var(--space-sm); }
    .flow ul { list-style: none; display: flex; flex-direction: column; gap: 6px; }
    .flow li {
      display: grid; grid-template-columns: 5.5rem minmax(0, 1fr);
      column-gap: var(--space-sm); align-items: baseline;
    }
    .flow li a { font-weight: var(--font-weight-semibold); text-decoration: none; }
    .flow li a:hover { text-decoration: underline; }
    .flow__io { color: var(--text-secondary); }
    .flow__io [aria-hidden] { color: var(--text-tertiary); }
    .flow code { white-space: nowrap; }
    .flow__python {
      margin-top: var(--space-sm); padding-top: var(--space-sm);
      border-top: 1px solid var(--border-subtle); color: var(--text-secondary);
    }

    /* App cards: the grid fills by width, so 3 to 8 apps need no changes */
    .cards {
      list-style: none; display: grid; gap: var(--space-md);
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
    }
    .card {
      height: 100%; display: flex; flex-direction: column;
      background: var(--bg-primary); border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg); overflow: hidden;
      color: inherit; text-decoration: none;
      transition: border-color var(--transition-normal), box-shadow var(--transition-normal);
    }
    .card:hover, .card:focus-visible { border-color: var(--accent); box-shadow: var(--shadow-elevated); color: inherit; }
    .card:focus-visible { outline-offset: 3px; }
    .card__thumb {
      aspect-ratio: 16 / 9; background: var(--bg-inset);
      border-bottom: 1px solid var(--border-subtle); overflow: hidden;
    }
    .card__thumb img {
      display: block; width: 100%; height: 100%;
      object-fit: cover; object-position: left top;
    }
    .card__body {
      flex: 1; display: flex; flex-direction: column; gap: var(--space-xs);
      padding: var(--space-md);
    }
    .card__title { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
    .card__title h2 { font-size: 1.15rem; font-weight: var(--font-weight-semibold); letter-spacing: -0.01em; }
    .card__desc { color: var(--text-secondary); font-size: 0.95rem; }
    .card__cta {
      margin-top: auto; padding-top: var(--space-sm);
      color: var(--accent); font-weight: var(--font-weight-medium); font-size: 0.9rem;
    }
    .card:hover .card__cta { color: var(--accent-hover); text-decoration: underline; }

    .badge {
      font-size: 0.72rem; font-weight: var(--font-weight-medium);
      padding: 1px 8px; border-radius: var(--radius-sm); white-space: nowrap;
    }
    .badge--stable { color: var(--success); background: color-mix(in srgb, var(--success) 8%, transparent); }
    /* --warning itself is too light for text on white; darken it for contrast */
    .badge--beta { color: color-mix(in srgb, var(--warning) 62%, #000); background: var(--warning-bg); }
    .badge--coming-soon { color: var(--text-secondary); background: color-mix(in srgb, var(--text-secondary) 8%, transparent); }

    /* Apps not released yet: a quiet list, not empty cards */
    .upcoming { margin-top: var(--space-xl); }
    .upcoming h2 { font-size: 0.95rem; font-weight: var(--font-weight-semibold); margin-bottom: var(--space-sm); }
    .upcoming ul { list-style: none; display: flex; flex-direction: column; gap: var(--space-sm); }
    .upcoming__item {
      display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-xs) var(--space-sm);
      padding: var(--space-sm) var(--space-md);
      background: var(--bg-inset); border: 1px solid var(--border-subtle); border-radius: var(--radius-md);
      color: inherit; text-decoration: none;
      transition: border-color var(--transition-normal);
    }
    .upcoming__item:hover { border-color: var(--accent); color: inherit; }
    .upcoming__item h3 { font-size: 1rem; font-weight: var(--font-weight-semibold); }
    .upcoming__desc { color: var(--text-secondary); font-size: 0.9rem; }

    footer {
      margin-top: var(--space-xl); padding: var(--space-lg) 0;
      border-top: 1px solid var(--border-subtle);
      font-size: 0.8rem; color: var(--text-secondary);
    }
    footer .page { display: flex; flex-direction: column; gap: var(--space-sm); }
    footer ul { list-style: none; display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-md); }
    footer a { color: var(--text-secondary); }
    footer a:hover { color: var(--accent); }
    .version { font-family: var(--font-mono); }

    @media (max-width: 820px) {
      .intro { grid-template-columns: minmax(0, 1fr); gap: var(--space-lg); padding-top: var(--space-lg); }
      .lede { font-size: 1.3rem; }
    }
    @media (max-width: 560px) {
      .page { padding: 0 var(--space-md); }
      .bar .page { padding-top: var(--space-sm); padding-bottom: var(--space-sm); }
      .bar nav { order: 3; margin-left: 0; width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition: none !important; }
    }

    /* Auth menu */
    .auth-landing { position: relative; }
    .auth-landing__avatar {
      width: 28px; height: 28px; border-radius: 50%; background: var(--accent);
      color: #fff; font-size: 0.8rem; font-weight: 600; display: flex;
      align-items: center; justify-content: center; border: none;
      cursor: pointer; padding: 0; line-height: 1;
    }
    .auth-landing__avatar:hover { background: var(--accent-hover); }
    .auth-landing__trigger {
      padding: 4px 12px; border: 1px solid var(--border-default); border-radius: var(--radius-md);
      background: var(--bg-primary); font: inherit; font-size: 0.8rem; cursor: pointer; color: var(--text-primary);
    }
    .auth-landing__trigger:hover { border-color: var(--accent); }
    .auth-landing__dropdown {
      position: absolute; top: calc(100% + 4px); right: 0; min-width: 240px;
      background: var(--bg-primary); border: 1px solid var(--border-default); border-radius: var(--radius-md);
      box-shadow: var(--shadow-elevated); padding: 8px; z-index: 100;
    }
    .auth-landing__email {
      font-size: 0.8rem; font-family: var(--font-mono);
      color: var(--text-secondary); padding: 4px; margin-bottom: 4px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .auth-landing__signout {
      display: block; width: 100%; padding: 4px; background: none;
      border: 1px solid var(--border-default); border-radius: var(--radius-sm); color: var(--text-primary);
      font-size: 0.8rem; cursor: pointer; text-align: center;
    }
    .auth-landing__signout:hover { background: var(--accent-muted); }
    .auth-landing__form input {
      width: 100%; padding: 6px 8px; border: 1px solid var(--border-default);
      border-radius: var(--radius-sm); font-size: 0.8rem; box-sizing: border-box;
    }
    .auth-landing__form button {
      width: 100%; margin-top: 8px; padding: 4px 12px; border: 1px solid var(--border-default);
      border-radius: var(--radius-md); background: var(--bg-primary); font-size: 0.8rem; cursor: pointer; color: var(--text-primary);
    }
    .auth-landing__form button:hover { border-color: var(--accent); }
    .auth-landing__sent { font-size: 0.8rem; color: var(--text-secondary); margin: 0; }
    .auth-landing__error { font-size: 0.75rem; color: var(--error); margin: 8px 0 0; }

    /* Auth callback page */
    .auth-cb { display: flex; align-items: center; justify-content: center; min-height: 60vh; padding: 24px; }
    .auth-cb__card {
      background: var(--bg-primary); border: 1px solid var(--border-default); border-radius: var(--radius-md);
      padding: 24px 48px; max-width: 420px; width: 100%; text-align: center;
      box-shadow: var(--shadow-elevated);
    }
    .auth-cb__icon { font-size: 2.5rem; color: var(--success); line-height: 1; margin-bottom: 8px; }
    .auth-cb__heading { font-size: 1.25rem; color: var(--text-primary); margin: 0 0 8px; font-weight: 600; }
    .auth-cb__text { color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <a class="skip-link" href="#apps">Skip to apps</a>
  <header class="bar">
    <div class="page">
      <h1>CaLab${version ? `<span class="version-tag">${versionText}</span>` : ''}</h1>
      <nav aria-label="Project links">
        <ul>
          <li><a href="${DOCS_URL}">Docs</a></li>
          <li><a href="${PYPI_URL}">Python package</a></li>
          <li><a href="${CHANGELOG_URL}">Changelog</a></li>
          <li><a href="${REPO_URL}">GitHub</a></li>
        </ul>
      </nav>
      ${authEnabled ? '<div id="auth-menu" class="auth-landing"></div>' : ''}
    </div>
  </header>
  <main class="page">
    <div class="intro">
      <div>
        <p class="lede">Calcium imaging analysis in the browser, from raw Miniscope video to cell traces and spikes.</p>
        <p class="intro__sub">Nothing to install, and your recordings never leave your computer: every app runs locally on a Rust solver compiled to WebAssembly. Built by the Aharoni Lab at UCLA as part of the <a href="${MINISCOPE_URL}">Miniscope project</a>.</p>
      </div>
${renderWorkflow(released)}
    </div>
    <section id="apps" aria-label="Apps">
      <ul class="cards">
${released.map(renderCard).join('\n')}
      </ul>
    </section>${upcomingHtml}
  </main>
  <footer>
    <div class="page">
      <p>CaLab collects anonymous usage statistics to support grant reporting. No personal data or IP addresses are stored.</p>
      <ul>
        ${versionLink ? `<li>${versionLink}</li>` : ''}
        <li><a href="${CHANGELOG_URL}">Changelog</a></li>
        <li><a href="${CITATION_URL}">Cite CaLab</a></li>
        <li><a href="${LICENSE_URL}">MIT License</a></li>
        <li><a href="${REPO_URL}">GitHub</a></li>
      </ul>
    </div>
  </footer>
  ${authEnabled ? authScript(supabaseUrl, supabaseAnonKey) : ''}
</body>
</html>
`;
}

/** Magic-link sign-in menu, and the confirmation shown on the auth callback. */
function authScript(supabaseUrl, supabaseAnonKey) {
  return `<script type="module">
    const SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
    const SUPABASE_ANON_KEY = ${JSON.stringify(supabaseAnonKey)};
    const container = document.getElementById('auth-menu');
    if (!container) throw new Error('Missing #auth-menu');

    const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
    const storageKey = 'sb-' + ref + '-auth-token';

    let dropdownOpen = false;
    let supabase = null;

    // Auth callback: if URL hash has access_token, show confirmation page
    const hash = window.location.hash;
    if (hash.includes('access_token=') || hash.includes('token_hash=')) {
      const page = document.querySelector('main');
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
  </script>`;
}
