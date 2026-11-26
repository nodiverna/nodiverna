// Playwright configuration for pnpm test:e2e (scripts/e2e.mjs).
// The browser runs in the container from e2e/compose.yaml; this runner connects
// to it through E2E_BROWSER_WS and tests the installation at BASE_URL.
import {defineConfig} from '@playwright/test';

const baseURL = process.env.BASE_URL;
const wsEndpoint = process.env.E2E_BROWSER_WS;
// The project readme exists only with E2E_README=1, so pnpm test:e2e without it
// runs exactly the smoke paths. It writes the README screenshots.
const readme = process.env.E2E_README === '1';
// The project perf exists only with E2E_PERF=1: frame timing in a shared container is noisy, so the frame budget of
// the palette and Help (e2e/overlay-performance.spec.ts) is measured on request, not on every pnpm test:e2e.
const perf = process.env.E2E_PERF === '1';

export default defineConfig({
  testDir: '.',
  outputDir: 'artifacts/test-results',
  workers: 1,
  retries: 0,
  fullyParallel: false,
  forbidOnly: true,
  timeout: 120_000,
  expect: {timeout: 15_000},
  reporter: [['list'], ['html', {outputFolder: 'artifacts/report', open: 'never'}]],
  use: {
    baseURL,
    ignoreHTTPSErrors: true, // The installation uses Caddy's internal CA.
    browserName: 'chromium',
    connectOptions: wsEndpoint ? {wsEndpoint} : undefined,
    // German browser: without the cookie of support/fixtures.ts the portal would also pick German through Accept-Language.
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    // Traces would carry the typed password; failure screenshots are enough.
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Once per run, before both viewport projects.
    {name: 'setup', testMatch: /owner\.setup\.ts$/, use: {viewport: {width: 1440, height: 900}, screenshot: 'off'}},
    {name: 'desktop', testMatch: /(?:smoke|csp)\.spec\.ts$/, dependencies: ['setup'], use: {viewport: {width: 1440, height: 900}}},
    {name: 'mobile', testMatch: /(?:smoke|csp)\.spec\.ts$/, dependencies: ['setup'], use: {viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true}},
    // The frame budget of the palette and Help (e2e/overlay-performance.spec.ts), only with E2E_PERF=1. The spec sets
    // the two viewports (1440×900, and 390×844 with touch and 4× CPU throttling) itself.
    ...(perf ? [{name: 'perf', testMatch: /overlay-performance\.spec\.ts$/, dependencies: ['setup'], use: {screenshot: 'off' as const}}] : []),
    // README screenshots in docs/images/ (e2e/readme.spec.ts), only with E2E_README=1.
    ...(readme ? [{name: 'readme', testMatch: /readme\.spec\.ts$/, dependencies: ['setup'], use: {viewport: {width: 1440, height: 900}, deviceScaleFactor: 2, screenshot: 'off' as const}}] : []),
  ],
});
