# Multiple Authenticator apps

Each TOTP app is a named `mfa_authenticators` row. The row has a random identifier, a 20-byte secret with AES-GCM encryption, its own replay counter, the creation time and the last successful use. The authenticated account view shows only metadata.

The login accepts a new six-digit code from each enrolled app. The login consumes each accepted counter atomically, together with the expected encrypted secret. When the portal issues a session, it checks that the same credential secret still exists. Thus a verification with an old secret that runs at the same time as a reset cannot create a new session.

## Account anchor

The `mfa_accounts` row stays the anchor for sessions and recovery. Its secret column holds an unusable marker. The login reads TOTP secrets only from `mfa_authenticators`. Newly enrolled accounts create the default entry and the anchor in the same transaction.

The old `begin`/`confirm` API is now only for the first enrollment. It cannot replace an existing account, erase recovery codes or bypass the method management. A pending first enrollment still has the original limit of ten minutes. A first enrollment with a passkey is the alternative (`setup-options`/`setup-verify`, refer to [passkeys.md](passkeys.md)). It removes a pending TOTP setup in the same transaction.

## Factor rule and passkey-only accounts

While MFA is enabled, a minimum of one factor (a passkey or an authenticator app) stays. Thus a user with a passkey can remove the last authenticator app, but nobody can remove the last factor. The two delete operations count the factors again in their committing transaction. Thus two concurrent delete operations cannot remove the last two factors.

Passkeys count as a remaining factor only while they are usable (`passkeysAvailable` is true in `GET /api/mfa`). The `authenticator-delete` operation returns 409 for the last authenticator app in these cases:

- No passkey exists: `You must keep at least one authenticator. …`
- Passkeys exist, but `SITE_ORIGIN` is an IP address or not HTTPS: `Your passkeys do not work at this address right now, so you must keep your last authenticator app.`

Both checks run before any write and leave the management proof unused. The account page disables the delete button in the same cases, and its tooltip tells why. For the last factor, passkey `delete` returns 409 with `You must keep at least one passkey or authenticator. Add another one before you remove this one.`

A passkey-only account has the `mfa_accounts` anchor (sentinel secret, `authenticators_migrated = 1`), its recovery codes and a minimum of one passkey. It has no `mfa_authenticators` row. All checks with `isMfaEnabled` see the account as an account with MFA. The user authenticates with a passkey or a recovery code. A TOTP code fails and counts as an attempt.

The step-up (the management proof) works in the same way. The dialog shows the passkey and a field for a recovery code instead of the authenticator code. The user can add an authenticator app later with a proof from a passkey. The user can disable MFA as before.

## New confirmation

A successful real login with TOTP, a recovery code or a passkey returns a random `managementToken` and `managementExpiresAt`. The portal keeps a hash of the token in `mfa_management_proofs`. The token is bound to the newly issued MFA session and principal. It expires in five minutes or less, and the portal consumes it one time. The MFA status, background activity and a sign-in through an MFA grant never return or make such a token. A replacement, the expiry or the logout of the bound session makes the token invalid.

These actions need this new proof: add, reset or remove an Authenticator, register a Passkey, make new recovery codes and disable MFA. A rename needs only a live authenticated session. New recovery codes and Passkey registration need the same protection. Without it, a person with a long-lived session could make a new factor and use it as a new proof.

## Authenticator API

`GET /api/mfa` includes `authenticatorCount`, `passkeyCount`, `passkeysAvailable` and `maximumAuthenticators` (10). `passkeysAvailable` tells if a passkey setup is possible on this origin. Only for a live MFA session, the response also includes `authenticators: [{id,name,createdAt,lastUsedAt}]`. `GET /api/passkeys` also returns `authenticatorCount`, a plain count for the step-up dialog. The status never returns secrets and proof tokens.

All changes use same-origin `POST /api/mfa`:

| Action | Input | Result |
| --- | --- | --- |
| `authenticator-begin` | `name`, `managementToken`, optional `id` for reset | `challengeId`, `secret`, `uri`, `expiresAt` |
| `authenticator-confirm` | `challengeId`, `code` of the new app | Updated metadata |
| `authenticator-cancel` | `challengeId` | Cancels the pending setup and does not change a credential |
| `authenticator-rename` | `id`, `name` | Updated metadata |
| `authenticator-delete` | `id`, `managementToken` | Updated metadata. A minimum of one app or passkey must stay; the last app stays while `passkeysAvailable` is false (409) |
| `regenerate-recovery` | `managementToken` | Ten new recovery codes for one use each |
| `disable` | `managementToken` | Removes the account credentials and revokes the sessions |

Authenticator names must contain 1–80 characters that are not control characters. The confirmation transaction checks the count limit again, because enrollments can occur at the same time.

A challenge to add or reset an app has encryption and expires in five minutes or less. It is bound to its originating session, principal and purpose. For a reset, it is also bound to the previous encrypted secret of the target. The user can confirm it only one time. The original app stays usable until a valid code proves the replacement. Cancel, timeout, failure and old target versions do not change the original app.

Add and reset keep the shared bundle of recovery codes. Reset and removal keep the MFA session of the browser that started them. They revoke the other sessions, the MFA grants of the principal and pending enrollment or Passkey work. Refer to [portal-sessions.md](portal-sessions.md#what-each-sign-in-asks-for). Changes to roles, access grants and portal membership cancel pending management proofs and challenges. They do this together with their existing session revocation.

`403 MFA_STEP_UP_REQUIRED` tells the UI to ask for a new real factor. An expired, consumed or invalid setup returns `409`. An unknown method of the user returns `404`. Invalid TOTP codes use the existing attempt limiter for the full account. Cookies keep the existing `__Host-`, Secure, HttpOnly and SameSite=Strict settings.

## Setup QR code

The first enrollment and the add or reset dialog show a QR code with the `otpauth://` URI of the setup. The browser makes the code as inline SVG with the pinned library `qrcode-generator`. The secret does not go to an external service, and the Content Security Policy does not change. The setup key, the copy button and the link stay available. When the setup expires, a notice replaces the QR code.

## Validation

Run `pnpm pipeline verify` for these checks: the account and security UI regressions, the access and session checks and the Node HTTP login flow with real TOTP enrollment. Also check multiple authenticators on an account that you can discard:

1. Add a second app.
2. Cancel an unfinished enrollment.
3. Make sure that the portal rejects a replayed code.
4. Reset one app.
5. Make sure that the other app and the recovery codes stay usable.
6. Make sure that you cannot remove the last usable method.

These scenarios need a current integration check of the portal. UI fixtures alone do not prove the full server lifecycle.
