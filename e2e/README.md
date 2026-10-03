# Browser smoke tests

One Playwright spec per web app, run in headless Chromium against the
production build of the combined GitHub Pages site. They catch what the unit
tests cannot, because those mock the solver and worker pool: WASM init, worker
boot, demo-data load, and first render.

## Run locally

```sh
npm run build:e2e        # build every app + landing page into dist/CaLab/
npx playwright install chromium   # once per Playwright version
npm run test:e2e         # headless; starts e2e/serve.mjs on :4173
npm run test:e2e:ui      # Playwright UI mode, for writing/debugging specs
```

`test:e2e` does not rebuild. Rerun `build:e2e` after changing app code.

`build:e2e` (`e2e/build-site.mjs`) builds with the Pages base path
(`/CaLab/<DisplayName>/`) and with `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`
blanked, even if your `.env` sets them. CI and forks build with no Supabase
config, so that is the mode under test. `e2e/serve.mjs` serves `dist/` with
Pages-like behaviour (directory index, `/dir` to `/dir/` redirect, 404s,
`application/wasm`). Set `E2E_PORT` to use a different port.

After a failure, `npx playwright show-report` opens the HTML report. In CI a
failed run uploads `playwright-report/` and `test-results/` (traces from the
retry) as the `playwright-report` artifact. Open a trace with
`npx playwright show-trace <trace.zip>`.

## What every test gets

Import `test` and `expect` from `./fixtures.ts`, not from `@playwright/test`.
The fixture fails the test on:

- any `console.error`, including ones logged inside workers, or an uncaught
  page error;
- any same-origin response with status 400 or higher (a missing chunk, worker
  or `.wasm`);
- any request to another host. Google Fonts is stubbed with an empty response.
  Everything else is blocked, which also proves the apps make no Supabase
  calls when it is not configured.

`CONSOLE_ERROR_ALLOW_LIST` in `fixtures.ts` is for benign, unavoidable errors.
It is empty. Give any entry you add a comment saying where the error comes from
and why it cannot be fixed at the source.

## Adding a spec for a new app

`landing.spec.ts` reads `apps/*/package.json` the same way
`scripts/combine-dist.mjs` does. A new app with a `calab.displayName` is
covered automatically: its landing card must link to `<DisplayName>/`, and the
page must load with the display name in its `<title>` and something mounted in
`#root`. Hidden apps must have no card.

An app made with `npm run new-app` (docs/NEW_APP.md) opens on the shared import
flow with a "Load Demo Data" button, so its spec can load a few demo cells and
wait for the trace view (`[data-panel-id="trace"] canvas`) until the app has a
real result to assert on.

Then add `e2e/<app-id>.spec.ts` that exercises the app's primary path:

```ts
import { test, expect } from './fixtures.ts';

test('MyApp: demo data loads and the main view renders', async ({ page }) => {
  await page.goto('MyApp/'); // relative to /CaLab/, the display name
  await expect(page.getByRole('heading', { level: 1, name: 'MyApp' })).toBeVisible();
  // Load the built-in demo/sample data, keeping it small so CI stays fast.
  // Then wait for a result that only exists if the real computation ran,
  // such as a metric or a drawn canvas, rather than just "the page loaded".
});
```

Guidelines:

- Prefer role, label and text selectors. Add a `data-testid` only when the
  element has no stable accessible handle, and keep app edits minimal.
- Assert on something the real WASM/worker path produces. See `catune.spec.ts`
  (per-card SNR labels appear only after a solve) and `cadecon.spec.ts` (a run
  reaches "Complete" and the raster canvas has pixels).
- Without a demo dataset, build a small input in the test. `carank.spec.ts`
  writes a `.npy` in memory and passes it to the file input.
- An app behind auth cannot get past its gate without Supabase. Assert that the
  gate renders and the protected view does not (see `admin.spec.ts`).
