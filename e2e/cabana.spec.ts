import { test, expect } from './fixtures.ts';

// CaBaNA is a coming-soon placeholder: the page is the shared import flow with
// no analysis behind it yet. This guards that the built page mounts.
test('CaBaNA: the placeholder opens on the import overlay', async ({ page }) => {
  await page.goto('CaBaNA/');
  await expect(page.getByRole('heading', { level: 1, name: 'CaBaNA' })).toBeVisible();
  await expect(page.getByText('Coming soon: behavioral and neural analysis')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load Demo Data' })).toBeVisible();
});
