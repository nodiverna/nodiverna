// README screenshots. Only the
// project readme runs this file, and it exists only with E2E_README=1:
//   E2E_README=1 BASE_URL=https://localhost:<port> pnpm test:e2e --project readme
// The path signs in like the smoke path, sets the English locale, opens the
// sample devices and writes viewport screenshots to docs/images/. The sample
// devices are fictional (ui/shell/demo.ts), so the images show no real host, address
// or token. The path changes no data. Each run overwrites the four files.
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Page} from '@playwright/test';
import {closeUsageNoticeAfter, expect, expectDashboard, expectFleet, fillSecret, openConsole, test} from './support/fixtures';
import {requireOwner, writeOwner} from './support/owner';
import {nextTotp} from './support/totp';

const imagesDir = fileURLToPath(new URL('../docs/images/', import.meta.url));
type Theme = 'light' | 'dark';

/** Sets the console language and appearance cookies (lib/i18n/locale.ts, lib/theme.ts) for the next load. */
async function preferences(page: Page, baseURL: string, theme: Theme): Promise<void> {
  const secure = new URL(baseURL).protocol === 'https:';
  await page.context().addCookies([
    {name: 'serverdesk-locale', value: 'en', url: baseURL, sameSite: 'Lax', secure},
    {name: 'serverdesk-theme', value: theme, url: baseURL, sameSite: 'Lax', secure},
  ]);
}

/** Loads the fleet with a full page load and starts the sample devices. */
async function sampleFleet(page: Page): Promise<void> {
  // A new hash on the same page loads nothing; about:blank forces the full load that applies the cookies.
  await page.goto('about:blank');
  await openConsole(page, '/#devices');
  await expectFleet(page);
  await page.getByRole('button', {name: /^(Beispielgeräte ansehen|View sample devices|Show sample devices)$/}).click();
  const fleet = page.locator('.sdx-fleet');
  for (const name of ['SRV-APP01', 'SRV-DC01', 'SRV-SQL01', 'SRV-FILE01']) await expect(fleet.locator('.sdx-device-cell', {hasText: name})).toBeVisible();
}

/** Waits until loading is done and no toast, dialog or usage notice is open, then writes a viewport screenshot. */
async function shoot(page: Page, file: string): Promise<void> {
  await expect(page.locator('[aria-busy="true"], .sdx-skeleton, .sd-loading')).toHaveCount(0);
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  await expect(page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible')).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.evaluate(async () => { await document.fonts.ready; });
  // Charts animate in with JavaScript; CSS animations stop below.
  await page.waitForTimeout(1500);
  mkdirSync(imagesDir, {recursive: true});
  await page.screenshot({path: path.join(imagesDir, file), animations: 'disabled', caret: 'hide'});
}

test('README-Screenshots', async ({page, baseURL}) => {
  test.setTimeout(300_000);
  if (!baseURL) throw new Error('BASE_URL is not set.');
  const owner = requireOwner();

  await test.step('Anmeldung mit MFA', async () => {
    await page.goto('/');
    await page.getByLabel(/^(Benutzername|Username)$/).fill(owner.username);
    await fillSecret(page.getByLabel(/^(Passwort|Password)$/), owner.password);
    await page.getByRole('button', {name: /^(Anmelden|Sign in)$/}).click();
    const {code, counter} = await nextTotp(owner.secret, owner.lastCounter);
    // The counter is spent as soon as the code is sent, whatever the outcome.
    writeOwner({...owner, lastCounter: counter});
    await page.getByLabel(/^(Authenticator-Code|Authenticator code)$/).fill(code);
    const closeNotice = closeUsageNoticeAfter(page);
    await page.getByRole('button', {name: /^(Anmelden|Sign in)$/}).click();
    await expectDashboard(page);
    await closeNotice();
  });

  for (const theme of ['light', 'dark'] as const) {
    await test.step(`Flotte ${theme}`, async () => {
      await preferences(page, baseURL, theme);
      await sampleFleet(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await shoot(page, `readme-fleet-${theme}.png`);
    });
  }

  await test.step('Gerät SRV-APP01', async () => {
    await preferences(page, baseURL, 'light');
    await sampleFleet(page);
    await page.locator('.sdx-fleet .sdx-device-cell', {hasText: 'SRV-APP01'}).click();
    await expect(page).toHaveURL(/#device\/demo-app$/);
    await expect(page.locator('.sdx-device .sdx-page-head h1')).toHaveText('SRV-APP01');
    await shoot(page, 'readme-device.png');
  });

  await test.step('Dienste von SRV-APP01', async () => {
    const areas = page.locator('.sdx-device nav.sdx-tabs');
    await areas.locator('a[href$="/management"]').click();
    await expect(areas.locator('a[aria-current="page"]')).toHaveAttribute('href', /\/management$/);
    const subtabs = page.locator('.sdx-device .sdx-subtabs');
    await expect(subtabs.locator('button').first()).toHaveAttribute('aria-pressed', 'true');
    // The four sample services of SRV-APP01 (ui/shell/demo.ts).
    await expect(page.locator('.sdx-services .sdx-data-table tbody tr')).toHaveCount(4);
    // At 1440×900 the fourth row is below the fold; scroll the pane just far enough to show the whole list.
    await page.locator('.sdx-services .sdx-table-foot').evaluate(element => element.scrollIntoView({block: 'end'}));
    await shoot(page, 'readme-services.png');
  });
});
