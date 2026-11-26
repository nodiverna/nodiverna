# Passkeys in ServerDesk

Passkeys are a different method to complete the second authentication step of the portal. The local primary session with username and password stays mandatory. A passkey is the second factor after the password. It never replaces the password, so there is no login without a password.

A passkey alone cannot create a ServerDesk account, give access, change a role or bypass device permissions. The existing TOTP enrollment, the TOTP login and the recovery codes stay available.

## First setup with a passkey

A local account without MFA sees **Secure your access**. This occurs in these cases:

- After the user redeems an invitation. This includes the bootstrap owner.
- After a password reset of an account that never had MFA.
- After a user disabled MFA.

When passkeys are available, that screen shows **Set up with a Passkey** (recommended) with **This device / Windows Hello** and **Smartphone / QR code**. Below it, the screen shows **Set up authenticator app**. The user selects one option. A passkey user never needs to enroll TOTP.

The passkey counts as the MFA factor for two reasons. Registration and each authentication need user verification (device PIN or biometrics). WebAuthn binds the credential to the origin of this site, so the credential resists phishing.

`POST /api/passkeys` does the enrollment in two calls:

1. Send `action:'setup-options'` (`device:'local'|'phone'`).
2. Send `action:'setup-verify'` (`challengeId`, `response`).

The two calls need only the live password session (pending or bound). They need no MFA session and no management proof. The portal refuses them when MFA is enabled. The new passkey has the name **This device** or **My smartphone**, and the user can change the name later.

One transaction creates the MFA account, the credential, ten new recovery codes and the MFA session with its management proof. The same transaction writes the audit row with the stored audit action `MFA mit Passkey eingerichtet`. Some events can stop the setup: a different enrollment, a revoked password session or a duplicate credential ID. Then the transaction commits nothing, and the user must start the setup again.

The portal shows the recovery codes one time, as after the TOTP setup. If the user loses the passkey, each code replaces the passkey one time.

The passkey setup needs a stable HTTPS `SITE_ORIGIN` with a DNS name. On an IP address, the portal offers only the authenticator app.

## Adding passkeys

1. Authenticate with the ServerDesk username and password.
2. Complete the MFA step.
3. Open **My account → Sign-in & security**.
4. Select **Add Passkey**.
5. Enter a name that identifies the device.
6. Select the option for the local device or for the smartphone.
7. Complete the prompt of the browser or the operating system.

Open ServerDesk directly in its own browser tab for these operations. The portal rejects embedded previews from a different origin. To create, name or delete a passkey, you need a portal MFA session that is live now. If the session has expired, authenticate again first.

For a local Windows device, the browser can offer Windows Hello or a different compatible passkey provider. Windows Hello verifies the user with the configured PIN, fingerprint or face recognition. Windows, the browser and the selected provider control the availability and the location of the storage.

For a phone, the browser can offer **another device**. It then shows its native QR code and starts the FIDO authentication across devices. Do these steps:

1. Scan the QR code from the browser with a compatible phone.
2. Keep the phone near the computer.
3. Complete the verification prompt on the phone.

These items can be necessary: Bluetooth proximity, HTTPS, a compatible browser and phone, and a supported passkey provider. The portal never creates its own QR code with a login token or a private key. If a browser does not support the registration across devices, create the passkey directly in the portal on that phone.

The portal cannot force a passkey into **Microsoft Authenticator**. Microsoft designed the passkey flow of the Authenticator for supported Microsoft Entra work or school accounts and their Entra configuration. It is not a general passkey store for an independent ServerDesk relying party. Use Windows Hello or a different provider that supports the standard WebAuthn flow of this site. The authenticator app continues to work for the existing TOTP codes of ServerDesk.

On the locked login screen, select a passkey option. Then select a stored credential in the native prompt of the browser. An account without an authenticator app sees only the passkey options and **Use a recovery code**.

A successful verified assertion creates the same ServerDesk MFA session as a successful TOTP login. It also rotates the local primary bearer and binds it to that exact MFA session. A passkey sign-in after the password gives the browser the same MFA grant of 8 hours as a TOTP sign-in, refer to [portal-sessions.md](portal-sessions.md#what-each-sign-in-asks-for).

## Security and persistence

The server uses `@simplewebauthn/server` to verify the attestation and the assertion of a credential. Registration and authentication both need user verification. The expected origin and the RP ID come from the configured HTTPS `SITE_ORIGIN`, not from the incoming Host header. The relying-party ID is the hostname of this origin. Each credential belongs to the authenticated principal. The authentication offers only the credential identifiers of that principal.

The database stores the credential identifier, the public key, the signature counter, the supported transports, device metadata and a display name. The private key of a passkey stays in the selected authenticator or provider. The API never returns private keys. The management list returns credential names and identifiers only while the requester has a live MFA session. The safe locked status shows only the number of credentials of that principal.

Each ceremony uses a random challenge with a lifetime of five minutes. Each challenge is bound to its principal and to an independent browser cookie. This cookie is Secure, HttpOnly, SameSite=Strict and host-only. The verification consumes a challenge one time. A replay, an expired challenge or the use from a different browser or principal cannot issue a session.

Mutations need the configured same origin. If a stored authenticator has a signature counter that is not zero, it rejects a counter rollback. Synced authenticators can correctly use a zero counter. The WebAuthn signature check and the user verification check stay mandatory.

The passkey authentication uses the existing random, hashed `mfa_sessions` token. It also uses the Secure, HttpOnly host cookie as the only transport. A session expires after the configured idle time without user input. The default is 15 minutes, refer to [portal-sessions.md](portal-sessions.md). The session also has a fixed absolute maximum of 24 hours. Status reads and portal polling do not make a session longer.

The MFA grant has a fixed lifetime of 8 hours and is bound to the principal. An explicit logout revokes it. On each portal request, the portal checks the status of the local account, the binding to the primary session, the role and the group rights.

When you delete a passkey, these things occur:

- Nobody can authenticate with the passkey again.
- The portal revokes the active sessions that the passkey created.
- The portal revokes the MFA grants of that principal.

Sessions that a user created with TOTP or with a different passkey stay usable. You cannot delete the last factor. While MFA is enabled, a minimum of one passkey or authenticator app stays (refer to [mfa-authenticators.md](mfa-authenticators.md)). When you disable MFA, the passkey authentication also stops until the user enrolls MFA again.

Passkeys count as that remaining factor only while they are usable. When `SITE_ORIGIN` is an IP address or not HTTPS, you cannot remove the last authenticator app. Then `authenticator-delete` returns 409 with `Your passkeys do not work at this address right now, so you must keep your last authenticator app.` The account page also disables the delete button of that app.

Keep the HTTPS origin and the hostname of the production installation stable. Passkeys are bound to the RP ID. If you change to a different, unrelated hostname, you must register new passkeys. The production migration adds the passkey tables. It does not replace or disable existing TOTP accounts. Credentials from a preview domain do not automatically work on a different production domain.

After a change of `SITE_ORIGIN` or of its hostname (the RP ID), stored passkeys stop working. They also do not work while `SITE_ORIGIN` is an IP address or not HTTPS. Then the users of passkey-only accounts need their recovery codes. They authenticate with a recovery code and add an authenticator app or new passkeys. Tell the users before you change the address.

ServerDesk does not store the RP ID for each credential. Thus it cannot find passkeys of an earlier hostname when the new `SITE_ORIGIN` is a valid HTTPS name. Only an IP address or an origin without HTTPS keeps the last authenticator app, as the last-factor rule above tells.

The user handle of a passkey is the hash of the internal principal of the account. This principal never changes. Thus a new username or a new password does not make stored passkeys invalid.

### Threat model and limits

- Registration uses `attestationType: 'none'`. Thus the user verification (UV) flag comes from the authenticator itself, and nothing confirms it. A software authenticator can set the UV flag. There is no allow-list of AAGUIDs. A passkey is only as strong as the device or the provider that keeps it.
- The password stays the first factor. A passkey is the second factor and never replaces the password.
- The origin binding stays. The expected origin and the RP ID come from `SITE_ORIGIN`, so a passkey does not work on a different site.

## Isolated validation

Run `pnpm pipeline verify` for these checks: the UI regressions for accounts and security, the access and session checks and the Node HTTP login flow. For the passkey acceptance, use an account that you can discard on the stable HTTPS origin:

1. Register a credential and use it.
2. Make sure that the portal rejects reused or expired challenges.
3. Make sure that the account binding and the browser binding work.
4. Make sure that a deleted credential cannot authenticate.
5. Make sure that a disabled account cannot authenticate.

The current UI checks and TOTP HTTP checks do not give full integration coverage with a virtual authenticator.

Native Windows Hello and the phone QR code also need a check with a user device on the stable HTTPS production origin. An integration test with a virtual authenticator cannot prove the availability of the operating system or the provider.

## Platform references

- [Microsoft Entra passkey FAQ](https://learn.microsoft.com/en-us/entra/identity/authentication/passkey-faq)
- [Passkeys in Windows](https://learn.microsoft.com/en-us/windows/security/identity-protection/passkeys/)
