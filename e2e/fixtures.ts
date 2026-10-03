/**
 * Shared `test` for every smoke spec. Import `test` and `expect` from here,
 * not from @playwright/test, so each page gets the runtime-health guards:
 *
 * - any `console.error` or uncaught exception (`pageerror`) fails the test,
 *   unless it matches CONSOLE_ERROR_ALLOW_LIST below;
 * - any same-origin response with status >= 400 fails the test (a missing
 *   chunk, worker, or .wasm after a refactor);
 * - the suite is hermetic: requests to other hosts are blocked and fail the
 *   test, except Google Fonts, which is stubbed with an empty stylesheet.
 *   With VITE_SUPABASE_URL empty (CI, forks, `npm run build:e2e`) the apps
 *   must not reach out to anything else on load.
 *
 * The failures are collected while the test runs and asserted after the
 * test body, so the report shows every problem at once, with the step that
 * triggered it in the trace.
 */
import { test as base, expect, type Page } from '@playwright/test';

/**
 * console.error / pageerror messages that are benign and unavoidable. Each
 * entry needs a comment saying where it comes from and why it is not a bug.
 * Keep this empty unless there is no way to fix the source.
 */
const CONSOLE_ERROR_ALLOW_LIST: RegExp[] = [];

/** Hosts the apps legitimately load from; stubbed rather than fetched. */
const STUBBED_HOSTS: Record<string, { contentType: string; body: string }> = {
  // index.html of each app preloads JetBrains Mono with display=optional, so
  // an empty stylesheet just means the fallback monospace font is used.
  'fonts.googleapis.com': { contentType: 'text/css', body: '' },
  'fonts.gstatic.com': { contentType: 'font/woff2', body: '' },
};

interface PageHealth {
  /** Problems seen so far: console errors, page errors, bad responses, external requests. */
  problems: string[];
}

function isAllowed(message: string): boolean {
  return CONSOLE_ERROR_ALLOW_LIST.some((re) => re.test(message));
}

async function guardPage(page: Page, health: PageHealth, baseURL: string): Promise<void> {
  const origin = new URL(baseURL).origin;

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (isAllowed(text)) return;
    // Messages logged inside a dedicated worker arrive here too.
    const from = msg.worker() ? ` [worker ${msg.worker()!.url()}]` : '';
    const loc = msg.location();
    const at = loc.url ? ` (${loc.url}:${loc.lineNumber})` : '';
    health.problems.push(`console.error${from}: ${text}${at}`);
  });

  page.on('pageerror', (err) => {
    if (isAllowed(err.message)) return;
    health.problems.push(`pageerror: ${err.stack || err.message || String(err)}`);
  });

  page.on('response', (res) => {
    if (res.status() >= 400 && res.url().startsWith(origin)) {
      health.problems.push(`HTTP ${res.status()}: ${res.url()}`);
    }
  });

  // Context-level, so it also sees requests made from the solver workers.
  await page.context().route(
    (url) => url.origin !== origin,
    async (route) => {
      const url = new URL(route.request().url());
      const stub = STUBBED_HOSTS[url.hostname];
      if (stub) {
        await route.fulfill({ status: 200, contentType: stub.contentType, body: stub.body });
        return;
      }
      health.problems.push(`unexpected external request: ${route.request().url()}`);
      await route.abort('blockedbyclient');
    },
  );
}

export const test = base.extend<{ health: PageHealth }>({
  health: [
    async ({ page, baseURL }, use) => {
      const health: PageHealth = { problems: [] };
      await guardPage(page, health, baseURL!);
      await use(health);
      expect(health.problems, 'runtime errors while the page was open').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
