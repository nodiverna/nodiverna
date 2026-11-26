// Control check for the CSP collector in support/fixtures.ts: a forbidden
// image under the enforced policy must be blocked and show up as exactly one
// violation.
// Without this test a green run could also mean that the collector is blind.
import {expect, test} from './support/fixtures';

const probe = 'https://example.invalid/sd-csp-probe.png';

test('CSP-Verstöße werden erkannt', async ({page, pageErrors}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', {name: 'Bei Nodiverna anmelden'})).toBeVisible();

  // Wait in the page for the violation event and for the image to settle, so
  // the browser's own console messages about the probe have arrived as well.
  const outcome = await page.evaluate(src => new Promise<string>(resolve => {
    let pending = 2, result = '';
    const done = () => {
      if (--pending === 0) resolve(result);
    };
    document.addEventListener('securitypolicyviolation', event => {
      if (event.blockedURI.includes('example.invalid')) done();
    });
    const image = document.createElement('img');
    image.addEventListener('load', () => { result = 'load'; done(); });
    image.addEventListener('error', () => { result = 'error'; done(); });
    image.src = src;
    document.body.appendChild(image);
  }), probe);
  expect(outcome, 'the enforced policy blocks the probe image').toBe('error');

  const violations = () => pageErrors.filter(entry => entry.startsWith('csp '));
  await expect.poll(violations).toHaveLength(1);
  const [entry] = violations();
  expect(entry).toMatch(/^csp enforce img-src https:\/\/example\.invalid\//);

  // Remove the expected violation and the browser's console messages about
  // the probe (the blocked load). Anything else stays
  // in the list and fails this test after its last step.
  for (let index = pageErrors.length - 1; index >= 0; index--) {
    if (pageErrors[index].includes('example.invalid')) pageErrors.splice(index, 1);
  }
});
