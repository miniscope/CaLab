import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect } from './fixtures.ts';

interface AppEntry {
  displayName: string;
  hidden: boolean;
  status: string;
}

/**
 * The apps combine-dist publishes, read the same way it reads them
 * (apps/<name>/package.json `calab` block, `_template` excluded), so a new app
 * is covered without editing this spec.
 */
function publishedApps(): AppEntry[] {
  const appsDir = resolve(import.meta.dirname, '../apps');
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_template')
    .flatMap((d) => {
      try {
        const pkg = JSON.parse(readFileSync(join(appsDir, d.name, 'package.json'), 'utf-8'));
        if (pkg.calab?.displayName == null) return [];
        return [
          {
            displayName: pkg.calab.displayName,
            hidden: pkg.calab.hidden === true,
            status: pkg.calab.status ?? 'coming-soon',
          },
        ];
      } catch {
        return [];
      }
    });
}

const apps = publishedApps();
const listed = apps.filter((a) => !a.hidden);
// Released apps get a card linking to the app; coming-soon apps are listed
// under "In development" with no link.
const released = listed.filter((a) => a.status !== 'coming-soon');
const upcoming = listed.filter((a) => a.status === 'coming-soon');

test('landing page links a card to every released app, and none to coming-soon or hidden ones', async ({
  page,
}) => {
  await page.goto('./');
  await expect(page).toHaveTitle('CaLab');
  await expect(page.getByRole('heading', { level: 1, name: /^CaLab/ })).toBeVisible();

  // Each app card is a link wrapping the app's h2.
  const cards = page.getByRole('link').filter({ has: page.getByRole('heading') });
  await expect(cards).toHaveCount(released.length);
  for (const app of released) {
    const card = page.getByRole('link').filter({
      has: page.getByRole('heading', { level: 2, name: app.displayName, exact: true }),
    });
    await expect(card).toHaveAttribute('href', `${app.displayName}/`);
  }
  // Coming-soon apps are named under "In development" but link nowhere.
  for (const app of upcoming) {
    const heading = page.getByRole('heading', { level: 3, name: app.displayName, exact: true });
    await expect(heading).toBeVisible();
    await expect(page.getByRole('link').filter({ has: heading })).toHaveCount(0);
    await expect(page.locator(`a[href="${app.displayName}/"]`)).toHaveCount(0);
  }
  for (const app of apps.filter((a) => a.hidden)) {
    await expect(page.getByRole('heading', { name: app.displayName, exact: true })).toHaveCount(0);
  }
});

test('a card details button expands and collapses its feature list', async ({ page }) => {
  await page.goto('./');
  const toggle = page.getByRole('button', { name: /^Details about / }).first();
  test.skip((await toggle.count()) === 0, 'no released app lists features');
  const panel = page.locator(`#${await toggle.getAttribute('aria-controls')}`);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).toBeVisible();
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toBeHidden();
});

for (const app of released) {
  test(`landing card opens ${app.displayName}`, async ({ page }) => {
    await page.goto('./');
    await page
      .getByRole('link')
      .filter({ has: page.getByRole('heading', { name: app.displayName, exact: true }) })
      .click();
    await expect(page).toHaveURL(new RegExp(`/CaLab/${app.displayName}/$`));
    await expect(page).toHaveTitle(new RegExp(app.displayName));
    // The app's bundle loaded and mounted something into #root.
    await expect(page.locator('#root > *').first()).toBeVisible();
  });
}

test('apps.json is served and lists the same apps as the landing page', async ({ page }) => {
  await page.goto('./');
  // Fetched from the page so the fixture's same-origin status check applies.
  const manifest = await page.evaluate(async () => {
    const res = await fetch('apps.json');
    return { status: res.status, type: res.headers.get('content-type'), body: await res.json() };
  });
  expect(manifest.status).toBe(200);
  expect(manifest.type).toContain('application/json');
  expect(manifest.body.manifest_version).toBe(1);
  expect(typeof manifest.body.release).toBe('string');
  expect(Number.isNaN(Date.parse(manifest.body.generated_at))).toBe(false);

  const entries: { displayName: string; path: string; status: string }[] = manifest.body.apps;
  const linked = entries.filter((e) => e.status !== 'coming-soon');
  const cards = page.getByRole('link').filter({ has: page.getByRole('heading') });
  const cardHrefs = await cards.evaluateAll((els) => els.map((el) => el.getAttribute('href')));
  const cardNames = await cards.getByRole('heading').allTextContents();
  // Same released apps, in the same order as the cards.
  expect(linked.map((e) => `${e.path}/`)).toEqual(cardHrefs);
  expect(linked.map((e) => e.displayName)).toEqual(cardNames);
  expect(entries.map((e) => e.displayName).sort()).toEqual(listed.map((a) => a.displayName).sort());
});
