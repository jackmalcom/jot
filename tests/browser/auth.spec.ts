import { test, expect } from '@playwright/test';
import { password, provision } from './operator';

test('login persists a month-long session across reloads', async ({
  page,
  request,
}) => {
  const email = await provision(request, 'Session');
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();

  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) =>
    cookie.name.endsWith('better-auth.session_token'),
  );
  expect(session).toBeDefined();
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Lax');
  const remaining = session!.expires - Date.now() / 1000;
  expect(remaining).toBeGreaterThan(30 * 24 * 60 * 60 - 60);
  expect(remaining).toBeLessThanOrEqual(30 * 24 * 60 * 60);
  expect(cookies.some((cookie) => cookie.name.includes('session_data'))).toBe(
    false,
  );

  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toHaveCount(0);
});
