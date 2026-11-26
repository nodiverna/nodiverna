// Setup step, once per run before both projects: redeem the owner invitation in
// the browser, set up the authenticator app and keep the credentials in
// e2e/.auth/owner.json. If the file already belongs to BASE_URL, nothing is set
// up again, so runs against the same installation can be repeated.
import {randomBytes} from 'node:crypto';
import {expect, fillSecret, test} from './support/fixtures';
import {OWNER_USERNAME, baseUrl, originOf, readOwner, writeOwner} from './support/owner';
import {nextTotp} from './support/totp';

test('owner with authenticator app', async ({page}) => {
  const base = baseUrl();
  if (readOwner(base)) {
    test.info().annotations.push({type: 'owner', description: 'e2e/.auth/owner.json exists for this BASE_URL; nothing to set up.'});
    return;
  }
  const invitation = process.env.E2E_INVITATION_URL;
  if (!invitation) throw new Error(`E2E_INVITATION_URL is not set and e2e/.auth/owner.json does not exist for ${base}. Run bootstrap-owner in the app container and pass its invitationUrl.`);
  if (originOf(invitation) !== originOf(base)) throw new Error('E2E_INVITATION_URL does not belong to BASE_URL');

  const password = randomBytes(24).toString('base64url');
  await page.goto(invitation);
  await expect(page.getByRole('heading', {name: 'Einladung annehmen'})).toBeVisible();
  await page.getByLabel('Benutzername').fill(OWNER_USERNAME);
  await fillSecret(page.getByLabel('Neues Passwort'), password);
  await fillSecret(page.getByLabel('Passwort wiederholen'), password);
  await page.getByRole('button', {name: 'Konto aktivieren'}).click();

  await expect(page.getByRole('heading', {name: 'Zugriff absichern'})).toBeVisible();
  await page.getByRole('button', {name: 'Authenticator-App einrichten'}).click();
  await expect(page.getByRole('heading', {name: 'MFA einrichten'})).toBeVisible();
  const secret = (await page.locator('.sd-session-secret code').innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

  const {code, counter} = await nextTotp(secret, null);
  await page.getByLabel('Authenticator-Code').fill(code);
  await page.getByRole('button', {name: 'MFA aktivieren'}).click();
  await expect(page.getByRole('heading', {name: 'Wiederherstellungscodes'})).toBeVisible();
  // The invitation is used up now; keep the credentials before anything else can fail.
  writeOwner({baseUrl: originOf(base)!, username: OWNER_USERNAME, password, secret, lastCounter: counter});

  await page.getByRole('button', {name: /^Weiter zu Nodiverna/}).click();
  // The console opens on the Dashboard; a new portal has no device yet.
  await expect(page.locator('.sdx-dash-status, .sdx-dash-page-empty').first()).toBeVisible();
});
