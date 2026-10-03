import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect } from './fixtures.ts';

interface AppEntry {
  displayName: string;
  hidden: boolean;
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
        return [{ displayName: pkg.calab.displayName, hidden: pkg.calab.hidden === true }];
      } catch {
        return [];
      }
    });
}

const apps = publishedApps();
const listed = apps.filter((a) => !a.hidden);

test('landing page links a card to every listed app and none to hidden ones', async ({ page }) => {
  await page.goto('./');
  await expect(page).toHaveTitle('CaLab');
  await expect(page.getByRole('heading', { level: 1, name: /^CaLab/ })).toBeVisible();

  // Each app card is a link wrapping the app's h2.
  const cards = page.getByRole('link').filter({ has: page.getByRole('heading', { level: 2 }) });
  await expect(cards).toHaveCount(listed.length);
  for (const app of listed) {
    const card = page.getByRole('link').filter({
      has: page.getByRole('heading', { level: 2, name: app.displayName, exact: true }),
    });
    await expect(card).toHaveAttribute('href', `${app.displayName}/`);
  }
  for (const app of apps.filter((a) => a.hidden)) {
    await expect(page.getByRole('heading', { name: app.displayName, exact: true })).toHaveCount(0);
  }
});

for (const app of listed) {
  test(`landing card opens ${app.displayName}`, async ({ page }) => {
    await page.goto('./');
    await page
      .getByRole('link')
      .filter({ has: page.getByRole('heading', { level: 2, name: app.displayName, exact: true }) })
      .click();
    await expect(page).toHaveURL(new RegExp(`/CaLab/${app.displayName}/$`));
    await expect(page).toHaveTitle(new RegExp(app.displayName));
    // The app's bundle loaded and mounted something into #root.
    await expect(page.locator('#root > *').first()).toBeVisible();
  });
}
