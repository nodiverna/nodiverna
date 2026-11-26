// Shared test fixtures for the smoke paths: page error collection, screenshots,
// the axe check and the console helpers.
import AxeBuilder from '@axe-core/playwright';
import {expect, test as base, type Locator, type Page, type TestInfo} from '@playwright/test';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {artifactsDir} from './owner';
import {allowedPageError} from './page-errors';

export {expect};

/** The fields of a securitypolicyviolation event the collector reports. */
type CspViolation = {disposition: string; effectiveDirective: string; blockedURI: string; sourceFile: string; lineNumber: number};

/** Name of the binding the init script reports CSP violations to. */
const cspBinding = '__serverdeskCspViolation';

/**
 * Runs in every document before its own scripts. Init scripts and bindings
 * come through the DevTools protocol, so the page's CSP does not apply to them.
 */
function reportCspViolations(binding: string): void {
  const bindings = window as unknown as Record<string, (violation: CspViolation) => Promise<void>>;
  window.addEventListener('securitypolicyviolation', event => {
    void bindings[binding]({disposition: event.disposition, effectiveDirective: event.effectiveDirective, blockedURI: event.blockedURI, sourceFile: event.sourceFile, lineNumber: event.lineNumber});
  }, true);
}

/** The list entry for one CSP violation: `csp <disposition> <directive> <blocked URI> (<source>:<line>)`. */
function cspEntry(violation: CspViolation): string {
  return `csp ${violation.disposition} ${violation.effectiveDirective} ${violation.blockedURI} (${violation.sourceFile}:${violation.lineNumber})`;
}

/**
 * Every test gets its page errors collected: each pageerror, each console
 * message of type error and each CSP violation, enforced or report-only
 * (securitypolicyviolation). The path fails with the list after its last step,
 * unless the message matches an entry in support/page-errors.ts. Each test also
 * gets the cookie serverdesk-locale=de (germanLocale).
 */
export const test = base.extend<{pageErrors: string[]; germanLocale: void}>({
  // The paths check the German labels. English is the portal default, so every page
  // gets the language cookie, as after a choice in the account menu.
  germanLocale: [async ({context, baseURL}, provide) => {
    if (baseURL) await context.addCookies([{name: 'serverdesk-locale', value: 'de', url: baseURL}]);
    await provide();
  }, {auto: true}],
  pageErrors: [async ({page}, provide) => {
    const errors: string[] = [];
    await page.exposeBinding(cspBinding, (_source, violation: CspViolation) => {
      const entry = cspEntry(violation);
      if (!allowedPageError(entry)) errors.push(entry);
    });
    await page.addInitScript(reportCspViolations, cspBinding);
    page.on('pageerror', error => {
      const text = `${error.name}: ${error.message}`;
      if (!allowedPageError(text)) errors.push(`pageerror ${text}`);
    });
    page.on('console', entry => {
      if (entry.type() !== 'error') return;
      const text = entry.text();
      if (allowedPageError(text)) return;
      const {url, lineNumber} = entry.location();
      errors.push(`console.error ${text}${url ? ` (${url}:${lineNumber})` : ''}`);
    });
    await provide(errors);
    if (errors.length) throw new Error(`The page reported ${errors.length} error(s) during this path:\n${errors.map(line => `  - ${line}`).join('\n')}`);
  }, {auto: true}],
});

const axeTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const impacts = ['critical', 'serious', 'moderate', 'minor'] as const;

/** Full-page screenshot and axe report of the current page under e2e/artifacts/. Violations are only reported. */
export async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const project = testInfo.project.name;
  const screenshot = path.join(artifactsDir, 'screenshots', project, `${name}.png`);
  mkdirSync(path.dirname(screenshot), {recursive: true});
  await page.screenshot({path: screenshot, fullPage: true});
  await testInfo.attach(`${name}.png`, {path: screenshot, contentType: 'image/png'});

  const results = await new AxeBuilder({page}).withTags(axeTags).analyze();
  const body = JSON.stringify(results, null, 2);
  const report = path.join(artifactsDir, 'axe', `${project}-${name}.json`);
  mkdirSync(path.dirname(report), {recursive: true});
  writeFileSync(report, body);
  await testInfo.attach(`axe-${name}.json`, {body, contentType: 'application/json'});
  const count = (impact: string) => results.violations.filter(violation => violation.impact === impact).length;
  console.log(`axe ${project} ${name}: ${results.violations.length} violations (${impacts.map(impact => `${impact} ${count(impact)}`).join(', ')})`);
}

/** Write into an input without the value showing up in step titles of the report. */
export async function fillSecret(input: Locator, value: string): Promise<void> {
  await input.evaluate((element, text) => {
    const field = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, text);
    field.dispatchEvent(new Event('input', {bubbles: true}));
  }, value);
  await expect(input).not.toHaveValue('');
}

const usageNotice = 'Daten zur Produktverbesserung';

/**
 * While usage data is on, the console asks an Owner about it on every load until it
 * is decided. Closing the notice saves nothing; the paths must not change data.
 * While it is off (enabled false, runtime/usage-report.mjs) no dialog opens.
 * Call before the action that loads the console, then await the result after it.
 */
export function closeUsageNoticeAfter(page: Page): () => Promise<void> {
  const view = page.waitForResponse(response => new URL(response.url()).pathname === '/api/usage-data' && response.request().method() === 'GET', {timeout: 30_000});
  return async () => {
    const body = await (await view).json() as {enabled?: unknown; consent?: unknown};
    if (body.enabled !== true || body.consent !== null) return;
    const dialog = page.getByRole('dialog', {name: usageNotice});
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  };
}

/** Load the console at a hash route with a full page load and close the usage data notice. */
export async function openConsole(page: Page, route: string): Promise<void> {
  const close = closeUsageNoticeAfter(page);
  await page.goto(route);
  await close();
}

/** The Dashboard, the start page after sign-in, is visible: its status line, or its empty state without a device. */
export async function expectDashboard(page: Page): Promise<void> {
  await expect(page.locator('.sdx-dash-status, .sdx-dash-page-empty').first()).toBeVisible();
}

/** The fleet is visible: its empty state or a device list. */
export async function expectFleet(page: Page): Promise<void> {
  const fleet = page.locator('.sdx-fleet');
  await expect(fleet).toBeVisible();
  await expect(fleet.getByText('Noch kein Gerät verbunden').or(fleet.locator('.sdx-table tbody tr, .sdx-device-card')).first()).toBeVisible();
}
