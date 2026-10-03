import { test, expect } from './fixtures.ts';

/**
 * The admin dashboard is behind AdminGuard. The smoke build has no Supabase
 * config (see e2e/build-site.mjs), and in that mode the guard's first gate is
 * "Configuration Required" instead of the sign-in form, so that is what this
 * asserts: the bundle boots, the guard mounts, and no admin data view leaks
 * through without auth. The sign-in form itself needs a Supabase URL and is
 * not covered here.
 */
test('Admin: the auth guard renders and blocks the dashboard', async ({ page }) => {
  await page.goto('Admin/');

  await expect(page.getByRole('heading', { name: 'Configuration Required' })).toBeVisible();
  await expect(page.getByText('Supabase environment variables are not configured.')).toBeVisible();

  // Nothing behind the guard rendered.
  await expect(page.getByRole('heading', { name: 'CaLab Admin' })).toHaveCount(0);
  await expect(page.getByRole('navigation')).toHaveCount(0);
});
