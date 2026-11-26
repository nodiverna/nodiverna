// Four smoke paths per project (desktop 1440×900, mobile 390×844): sign-in
// with MFA, the fleet with a sample device, the pages "Nutzungsdaten" (through
// the old link #settings/license), "Microsoft Entra ID" and "Kunden", and the
// remote access of a sample device. Paths 1 to 3 take a full-page screenshot
// and an axe report of each page. The paths change no data: no customer, no
// usage data decision, no remote session. Paths 2 and 3 also check the fixed console frame.
import type {Page, TestInfo} from '@playwright/test';
import {translate} from '../lib/i18n/translate';
import {capture, closeUsageNoticeAfter, expect, expectDashboard, expectFleet, fillSecret, openConsole, test} from './support/fixtures';
import {requireOwner, stateFile, writeOwner} from './support/owner';
import {nextTotp} from './support/totp';

// Paths 2 to 4 use the session of path 1; without it they are skipped.
test.describe.configure({mode: 'serial'});

/** The console frame stays put: a hard wheel scroll past the end of the workspace never
 *  scrolls the document, the document has no overflow, and the collapsed job dock sits at the
 *  bottom edge (above the bottom tab bar on mobile). */
async function expectFixedFrame(page: Page, testInfo: TestInfo): Promise<void> {
  const main = page.locator('#console-content');
  const box = await main.boundingBox();
  expect(box, 'the workspace is on screen').not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + Math.min(box!.height / 2, 40));
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 20000);
  await expect.poll(() => main.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1), {message: 'the workspace reached its end'}).toBe(true);
  await page.mouse.wheel(0, 20000);
  const frame = await page.evaluate(() => {
    const root = document.scrollingElement!;
    const edge = (selector: string, side: 'top' | 'bottom') => document.querySelector(selector)?.getBoundingClientRect()[side] ?? null;
    const dock = document.querySelector('.sdx-dock');
    return {scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, innerHeight, dock: edge('.sdx-dock', 'bottom'), dockShown: !!dock && getComputedStyle(dock).display !== 'none', rail: edge('.sdx-rail', 'bottom'), topbar: edge('.sdx-topbar', 'top')};
  });
  expect(frame.scrollTop, 'the document never scrolls').toBe(0);
  expect(frame.scrollHeight, 'the document has no overflow').toBeLessThanOrEqual(frame.innerHeight);
  expect(frame.topbar, 'the top bar stays at the top edge').toBe(0);
  if (testInfo.project.name === 'desktop') {
    expect(Math.abs(frame.dock! - frame.innerHeight), 'the job dock sits at the bottom of the frame').toBeLessThanOrEqual(1);
  } else {
    // At 900px or narrower there is no dock bar: the bottom bar (with its Jobs item) is the bottom edge.
    expect(frame.dockShown, 'no job dock bar on a phone').toBe(false);
    expect(Math.abs(frame.rail! - frame.innerHeight), 'the bottom bar sits at the bottom of the frame').toBeLessThanOrEqual(1);
  }
}

test('Anmeldung mit MFA', async ({page}, testInfo) => {
  const owner = requireOwner();
  const response = await page.goto('/');
  // Every path runs under the one complete enforced policy
  // (lib/server/csp.ts); the fixture fails on any violation.
  const headers = response?.headers() ?? {};
  const policy = headers['content-security-policy'] ?? '';
  expect(policy, 'the enforced policy carries a nonce').toMatch(/'nonce-[^']+'/);
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("form-action 'self'");
  // The installation runs behind HTTPS, so its SITE_ORIGIN is https:.
  expect(policy).toContain('upgrade-insecure-requests');
  expect(headers['content-security-policy-report-only'], 'no report-only policy next to the enforced one').toBeUndefined();
  await expect(page.getByRole('heading', {name: 'Bei Nodiverna anmelden'})).toBeVisible();
  await expect(page.getByLabel('Benutzername')).toBeEditable();
  await capture(page, testInfo, 'login');

  await page.getByLabel('Benutzername').fill(owner.username);
  await fillSecret(page.getByLabel('Passwort'), owner.password);
  await page.getByRole('button', {name: 'Anmelden', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Anmelden', exact: true})).toBeVisible();

  const {code, counter} = await nextTotp(owner.secret, owner.lastCounter);
  // The counter is spent as soon as the code is sent, whatever the outcome.
  writeOwner({...owner, lastCounter: counter});
  await page.getByLabel('Authenticator-Code').fill(code);
  const closeNotice = closeUsageNoticeAfter(page);
  await page.getByRole('button', {name: 'Anmelden', exact: true}).click();
  // Without a link the console opens on the Dashboard, the default start page.
  await expectDashboard(page);
  await closeNotice();
  await page.context().storageState({path: stateFile(testInfo.project.name)});
});

test.describe('angemeldet', () => {
  test.use({storageState: async ({}, provide, testInfo) => provide(stateFile(testInfo.project.name))});

  test('Flotte mit Gerätedetail', async ({page}, testInfo) => {
    await openConsole(page, '/#devices');
    await expectFleet(page);
    await page.getByRole('button', {name: 'Beispielgeräte ansehen'}).click();
    await expect(page.getByRole('group', {name: 'Beispielgeräte'})).toBeVisible();
    const device = page.locator('.sdx-fleet .sdx-device-cell', {hasText: 'SRV-APP01'});
    await expect(device).toBeVisible();
    await capture(page, testInfo, 'fleet');
    await expectFixedFrame(page, testInfo);

    await device.click();
    await expect(page).toHaveURL(/#device\/demo-app$/);
    await expect(page.locator('.sdx-device .sdx-page-head h1')).toHaveText('SRV-APP01');
    await expect(page.getByRole('navigation', {name: 'Gerätebereiche'}).locator('a[aria-current="page"]')).toHaveText('Überblick');
    await capture(page, testInfo, 'device');
    await expectFixedFrame(page, testInfo);
  });

  test('Nutzungsdaten und Kunden', async ({page}, testInfo) => {
    // The old link of the License page opens the page Usage data.
    await openConsole(page, '/#settings/license');
    await expect(page).toHaveURL(/#settings\/usage-data$/);
    await expect(page.getByRole('heading', {level: 1, name: translate('de', 'nav.settings.usageData')})).toBeVisible();
    // The page shows a skeleton until the usage data are there. Usage data is off in this version: the notice says so,
    // and the card below it is blurred, inert and hidden from assistive technology.
    await expect(page.getByRole('status').filter({hasText: translate('de', 'usage.disabled.notice')})).toBeVisible();
    await expect(page.locator('.sdx-usage-disabled[inert][aria-hidden="true"]').getByRole('region', {name: translate('de', 'usage.title'), exact: true, includeHidden: true})).toBeVisible();
    await capture(page, testInfo, 'usage-data');
    await expectFixedFrame(page, testInfo);

    // The Entra settings page is long and has sr-only text deep down: the case of the report.
    await page.goto('/#settings/entra');
    await expect(page.getByRole('heading', {level: 1, name: 'Microsoft Entra ID'})).toBeVisible();
    await expectFixedFrame(page, testInfo);

    // Customers is a page of every Owner, also with only the default customer.
    await page.goto('/#settings/customers');
    await expect(page.getByRole('heading', {level: 1, name: translate('de', 'nav.settings.customers')})).toBeVisible();
  });

  // Remote access must render under the enforced policy: the area tab
  // "Fernzugriff" in the area bar "Gerätebereiche" of a sample device, its
  // subtabs "Dateien", "Terminal" and "Remote Desktop" (tag "Pausiert") with
  // the sample-device and pause notices, and the paused /remote-desktop page.
  // Sample devices open no session, so the path changes no data. The fixture
  // fails on any CSP violation.
  test('Fernzugriff ohne CSP-Verstoß', async ({page}) => {
    await openConsole(page, '/#devices');
    await expectFleet(page);
    await page.getByRole('button', {name: 'Beispielgeräte ansehen'}).click();
    await page.locator('.sdx-fleet .sdx-device-cell', {hasText: 'SRV-APP01'}).click();
    await expect(page).toHaveURL(/#device\/demo-app$/);

    // The area bar is the kit Tabs: a nav landmark around a tablist of link tabs.
    const areas = page.getByRole('navigation', {name: translate('de', 'device.areas')}).getByRole('tablist');
    const remoteArea = areas.getByRole('tab', {name: translate('de', 'device.section.remote'), exact: true});
    await remoteArea.click();
    await expect(remoteArea).toHaveAttribute('aria-selected', 'true');
    // The subarea bar is the kit Tabs; blocked subareas name their reason (here: a sample device).
    const remote = page.getByRole('tablist', {name: translate('de','device.remoteArea')});
    const subtab = (name: string) => remote.getByRole('tab', {name, exact: true});
    // The subarea panel is named by its active tab; the same reason also sits on blocked buttons of the device head.
    const panel = (name: string) => page.getByRole('tabpanel', {name, exact: true});
    const demo = translate('de','kit.unavailable.demo');
    await expect(subtab('Dateien')).toHaveAttribute('aria-selected', 'true');
    await expect(panel('Dateien').getByText(demo)).toBeVisible();

    await subtab('Terminal').click();
    await expect(subtab('Terminal')).toHaveAttribute('aria-selected', 'true');
    await expect(panel('Terminal').getByText(demo)).toBeVisible();

    // Remote Desktop keeps its plain label and carries the state as a tag.
    const rdp = subtab('Remote Desktop Pausiert');
    await rdp.click();
    await expect(rdp).toHaveAttribute('aria-selected', 'true');
    await expect(rdp.locator('.sdx-tag', {hasText: 'Pausiert'})).toBeVisible();
    const rdpPanel = panel('Remote Desktop Pausiert');
    await expect(rdpPanel.getByText(translate('de','rdp.paused.title'), {exact: true})).toBeVisible();
    await expect(rdpPanel.getByText(translate('de','rdp.paused.notice'))).toBeVisible();
    await expect(rdpPanel.getByRole('button', {name: translate('de','rdp.paused.openTerminal')})).toBeVisible();

    await page.goto('/remote-desktop');
    await expect(page.getByText(translate('de','rdp.paused.title'), {exact: true})).toBeVisible();
    await expect(page.getByText(translate('de','rdp.paused.notice'))).toBeVisible();
  });
});
