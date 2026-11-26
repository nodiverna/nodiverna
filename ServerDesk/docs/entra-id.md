# Sign-in with Microsoft Entra ID

People of one Microsoft Entra ID tenant can sign in to the portal with their work account. The portal uses the OpenID Connect authorization code flow with PKCE. The built-in sign-in with user name, password and MFA continues to work.

Only a global Owner can see and change the settings. The settings are in **Settings → Microsoft Entra ID**.

## Register the app in Entra ID

Do these steps in the Microsoft Entra admin center. The app registration has these parts. Do them in this order:

1. [Create the app registration](#create-the-app-registration).
2. [Add a credential](#add-a-credential).
3. [Configure the token claims](#configure-the-token-claims): the groups claim and `auth_time`.
4. [Expose the portal API](#expose-the-portal-api).
5. [Add the API permissions](#add-the-api-permissions) and grant admin consent.
6. [Control the access to the app](#control-the-access-to-the-app).
7. [Check the setup](#check-the-setup).

The portal uses only `login.microsoftonline.com` and `graph.microsoft.com/v1.0`. Sovereign clouds are not supported.

### Create the app registration

1. Open **App registrations** and select **New registration**.
2. Enter a name for the app, for example `Nodiverna`.
3. Under **Supported account types**, select the single tenant option **Accounts in this organizational directory only**.
4. Select **Register**.
5. Under **Authentication**, add the platform **Web**.
6. Add the redirect URI from the card **App registration** of the settings page.
7. On the **Overview** page of the app, copy the **Directory (tenant) ID** and the **Application (client) ID**.
8. Enter the two values on the card **App registration** of the settings page.

The redirect URI is `SITE_ORIGIN` followed by `/api/auth/entra/callback`. The card shows it in the field **Redirect URI**. The tenant ID and the client ID must be GUIDs. A domain name or `common` is not accepted.

### Add a credential

1. Under **Certificates & secrets**, create a client secret or upload a certificate.
2. Enter the secret, or the certificate and its private key, on the settings page.
3. Select **Save**.

For the formats and the storage, refer to [Secret or certificate](#secret-or-certificate).

### Configure the token claims

> **Important:** Without the groups claim in the ID token, the portal gives no role from a group mapping. The sign-in still works, but the account has no rights.

Do these steps for the groups claim:

1. Under **Token configuration**, select **Add groups claim**.
2. Select the group type. For most tenants, select **Security groups**, refer to [Group types](#group-types).
3. Under the token types, find the section **ID**.
4. In the section **ID**, select the format **Group ID**.
5. Do not select **Emit groups as role claims**.
6. Select **Add**.

The claim must include the **ID** token, because the portal reads the groups only from the ID token. A groups claim only for the access token or for the SAML token does not help. The portal ignores each group value that is not a GUID, thus the format must be **Group ID**. With **Emit groups as role claims**, Entra sends the groups in the `roles` claim. The portal does not read this claim.

Do these steps for `auth_time`:

1. Under **Token configuration**, select **Add optional claim**.
2. For the token type, select **ID**.
3. Select the claim `auth_time`.
4. Select **Add**.

A sign-in without a live MFA grant and the confirmation with Microsoft need `auth_time`, refer to [Token configuration for the confirmation](#token-configuration-for-the-confirmation).

#### Group types

The group type tells Entra which groups of a person it sends:

- **Security groups**: Entra sends all security groups of the person, nested groups included. This is the recommended choice for most tenants.
- **Groups assigned to the application**: Entra sends only the groups that are assigned to the enterprise application. Use this type when people are in more than 200 groups.

With more than 200 groups, Entra sends no group list, and the sign-in fails with `groupsOverage`, refer to [Group mappings](#group-mappings).

The mapped group must be of the selected type. For example, **Security groups** does not send a Microsoft 365 group that is not a security group.

#### Assign the groups to the application

With **Groups assigned to the application**, assign each mapped group to the enterprise application. A mapped group that is not assigned gives no role. Group assignment needs Microsoft Entra ID P1 or P2. An assignment does not include the nested groups of a group, so assign each mapped group itself.

To assign a group, do these steps:

1. Open **Enterprise applications**.
2. Select the application that has the name of your app registration.
3. Under **Users and groups**, select **Add user/group**.
4. Under **Users and groups**, select the mapped group.
5. Select **Select**.
6. Select **Assign**.

Do these steps again for each mapped group.

### Expose the portal API

1. Under **Expose an API**, set the **Application ID URI** to `api://<client ID>`. The settings page shows this value.
2. Select **Add a scope**.
3. Enter the scope name `access_as_user`.
4. For **Who can consent**, select **Admins and users**.
5. Save the scope.
6. Under **Manifest**, make sure that `requestedAccessTokenVersion` is `null` or `1`.

The portal API gives the MFA of each sign-in, refer to [MFA](#mfa). The card **App registration** shows the application ID URI and the scope. Its copy button copies the application ID URI. The old manifest uses the name `accessTokenAcceptedVersion` for `requestedAccessTokenVersion`.

### Add the API permissions

1. Under **API permissions**, select **Add a permission → Microsoft Graph → Application permissions**.
2. Add `User.Read.All` and `GroupMember.Read.All`.
3. Select **Add a permission → My APIs**.
4. Select this app.
5. Add the delegated permission `access_as_user`.
6. Select **Grant admin consent**.

The account check uses the two Graph permissions, refer to [Account check](#account-check). The settings page shows them on the card **Account check**. Its copy button copies both names.

For the scope `access_as_user`, you can use a different procedure instead of the admin consent. Add the client ID as an authorized client application under **Expose an API**.

### Control the access to the app

This part is optional. Without it, each person of the tenant can sign in. Such an account has no rights until a group mapping or a manual role assignment gives some.

To limit who can sign in, do these steps:

1. Open **Enterprise applications**.
2. Select the application that has the name of your app registration.
3. Under **Properties**, set **Assignment required?** to **Yes**.
4. Select **Save**.
5. Under **Users and groups**, assign the users or groups that can use the portal.

With **Assignment required?**, the connection test can show `ok` for a refused API token, refer to [Test the connection](#test-the-connection).

### Check the setup

Do these steps after the setup and after each change of the token configuration:

1. Under **Token configuration**, make sure that the claim `groups` is in the list.
2. Make sure that the token types of `groups` include **ID**.
3. Make sure that the optional claim `auth_time` is in the list for the **ID** token.
4. On the settings page, select **Test connection**. The result must be `ok`.
5. Add one group mapping, refer to [Add a group mapping](#add-a-group-mapping).
6. Open a private browser window.
7. In this window, sign in with Microsoft with a test account. The account must be a member of the mapped group.
8. As a built-in Owner, open **All devices → Permissions**.
9. In the card **Direct**, make sure that the test account has the role with the tag **From Entra**.
10. Open **Settings → Audit log**.
11. Make sure that the log has a row `auth.entra.roles.sync` for the test account.
12. Optional: if the role is **Owner** for **All devices**, make sure that the test account sees **Settings** and all devices.

**Test connection** cannot see the groups claim, because it reads no ID token. Only a sign-in shows that the groups claim works.

## Secret or certificate

The app can prove its identity with a client secret or with a certificate.

- A client secret has 1 to 512 printable characters. The portal stores it encrypted with `SESSION_SECRET`.
- A certificate is a PEM X.509 certificate and its unencrypted RSA private key in PKCS#8 or PKCS#1 format. The key must have at least 2048 bits, and the certificate must be valid. Upload the same certificate to the app registration. The private key stays in the portal and is stored encrypted.

The settings page never shows a saved secret or key again. An empty secret or key field keeps the saved value.

With a certificate, the portal signs a client assertion with RS256. The header contains the SHA-1 thumbprint as `x5t`. The assertion is valid for 5 minutes.

## Test the connection

Select **Test connection** after each change. The test runs on the portal server and does these checks:

1. It reads the OpenID configuration of the tenant and checks the issuer.
2. It reads the signing keys of the tenant. At least one RSA key must be available.
3. It requests a token for Microsoft Graph with the secret or the certificate.
4. It reads one user with `accountEnabled` and one group from Microsoft Graph with this token.
5. It requests a token for the portal API (`api://<client ID>/.default`) with the same credential. It checks the signature, the issuer, the version and the audience.

The result is one of these codes: `ok`, `tenantNotFound`, `discoveryFailed`, `credentialRefused`, `secretExpired`, `certificateRefused`, `unreachable`, `graphPermissionMissing`, `graphUnreachable`, `apiNotExposed` or `apiTokenVersion`. The page shows what to do for each code.

- `graphPermissionMissing`: Graph refused a read, or the user has no `accountEnabled`. Add the two application permissions and grant admin consent.
- `graphUnreachable`: `graph.microsoft.com` cannot be reached, or it is busy.
- `apiNotExposed`: Entra does not know the application ID URI `api://<client ID>`, or the token is not for the portal API. Set the application ID URI under **Expose an API** and test again.
- `apiTokenVersion`: The portal API sends version 2.0 tokens. These tokens do not contain the MFA of a sign-in. Set `requestedAccessTokenVersion` to `1` in the manifest and test again.

When the enterprise application has **Assignment required?**, Entra can refuse the token of step 5 with the error 501051. The test then shows `ok`, because the API exists. The portal checks the token version at the sign-in.

The test cannot see the scope `access_as_user` or its consent. Step 5 asks for a token of the app itself, not for a token of a person. When the scope or its consent is missing, the sign-in fails with `apiSetupMissing`.

The switch needs `ok`, thus a new setup needs the Graph permissions. An installation that had the sign-in on before this step keeps it on. Its account check shows `permissionMissing` until you grant the permissions. The portal does not keep the error text from Microsoft.

An installation that passed the test before step 5 existed keeps its result and its switch. Its sign-ins fail with `apiSetupMissing` until you set up the portal API. Then test the connection again.

The test also cannot see the groups claim, because it reads no ID token. To check the groups claim, refer to [Check the setup](#check-the-setup).

## Turn on the sign-in

The switch **Allow sign-in with Microsoft** turns the sign-in on. You can turn it on only after a test with the result `ok` for the current settings. A change of the tenant, the client ID or the credential needs a new test.

The switch, the save of the settings and each change of the group mappings need a new MFA confirmation. The connection test does not need it.

When you turn the sign-in off, the portal ends the sessions of all Entra accounts at once. A change of the tenant, the client ID or the credential also ends these sessions. When the sign-in is on, such a change also turns it off until a new test passes.

## Sign in

While the sign-in is on, the sign-in page shows **Sign in with Microsoft** first. The form for built-in accounts stays below it. While Microsoft sign-in only is on, the form opens only with **Use emergency access**, refer to [Microsoft sign-in only](#microsoft-sign-in-only).

The portal asks Entra for two tokens in one sign-in: the ID token and the access token of the portal API. It checks both tokens with the signing keys of the tenant. The signing keys stay in memory for at most 24 hours. An unknown key ID loads the keys again, at most once in 5 minutes.

- The ID token: the signature, the issuer, the audience, the tenant, the time claims and the nonce.
- The access token of the portal API: the signature, version 1.0, the issuer of the tenant, the audience `api://<client ID>` and the client ID of the app. It also checks the time claims, the scope `access_as_user`, and the same tenant and object as the ID token.

The portal does not keep the tokens. When the portal API is not set up, the sign-in fails with `apiSetupMissing`. The audit row names the detail:

- `missing`: Entra sent no access token.
- `refused`: Entra refused the scope `access_as_user` or the application ID URI.
- `version`: the access token is not a version 1.0 token.
- `audience`: the access token is not for `api://<client ID>`.
- `scope`: the access token does not contain the scope `access_as_user`.

The first sign-in of a person creates an account. The account has the principal `entra:<tenant ID>:<object ID>` and the user name `entra.<object ID>`. It has no password. Later sign-ins update the display name and the email from the token. The account has no rights until a group mapping or a manual role assignment gives some.

Built-in user names cannot start with `entra.`. Built-in accounts cannot become Entra accounts.

A sign-in in a browser without a live MFA grant asks Microsoft for a new sign-in (`prompt=login`). The portal accepts it only when `auth_time` shows a sign-in at most 60 seconds before the start. Otherwise, the sign-in fails with the message for `staleSignIn`.

Such a sign-in gives the browser an MFA grant for 8 hours. Within these 8 hours, the next sign-in in the same browser sends no `prompt`, and Microsoft can answer from its own session. The sign-in after the idle timeout is the same sign-in. Refer to [portal-sessions.md](portal-sessions.md#what-each-sign-in-asks-for).

A grant applies only to the account that created it. When the account of the sign-in is a different one, or the grant ended, the portal starts a new sign-in with `prompt=login`. A sign-in through a grant never adds rights: when the role sync adds a role assignment, the portal ends the grant and starts a new sign-in with `prompt=login`.

## MFA

The portal accepts a sign-in only when Entra confirms MFA. The `amr` claim of the version 1.0 access token of the portal API must contain `mfa`. The ID token does not give this information. Otherwise, the sign-in fails with the message for `mfaMissing`.

Security defaults do not ask for MFA at each sign-in. Such a sign-in has no `mfa` in `amr`, and the portal refuses it. Set per-user MFA to **Enforced** for each person who uses the portal. With Entra ID P1, a Conditional Access policy that requires MFA for this app also works.

The portal does not ask for its own code after a Microsoft sign-in. The MFA of Entra is the MFA of the portal session. A sign-in through an MFA grant also needs `mfa` in `amr`.

When the portal refuses a sign-in with `mfaMissing`, the sign-in page shows the sign-in methods from the `amr` claim, for example `pwd`. The audit row names them as `amr=pwd`. A token without an `amr` claim gives `amr=missing`. The portal shows only known method names and replaces each other value with `other`.

## Group mappings

A group mapping gives a role to the members of an Entra group. Enter the object ID of the group, an optional name, a role and a scope. The scope is **All devices** or one device group. Only roles of the instance catalog are available. A role with portal rights applies only to all devices.

The portal reads the groups from the ID token at each sign-in. It stores them and updates the role assignments of the account in the same step. A change of the mappings updates all Entra accounts at once.

When the ID token has no groups claim, the portal stores no groups and shows no error. The account then gets no role from a mapping. To add the claim, refer to [Configure the token claims](#configure-the-token-claims). For the symptom, refer to [An account signs in but sees no settings and no devices](#an-account-signs-in-but-sees-no-settings-and-no-devices).

A person who leaves a mapped group in Entra loses the role within 15 minutes. The account check removes the group and the role and ends the sessions of the account, refer to [Account check](#account-check).

The roles of a mapping appear in the role assignments with the tag **From Entra**. You cannot remove such an assignment by hand. Remove or change the mapping instead. A device group or a role that a mapping uses cannot be deleted.

Entra sends at most 200 groups in a token. If a person is in more groups, Entra sends no group list, and the sign-in fails with `groupsOverage`. In this case, send only the groups that are assigned to the application, refer to [Group types](#group-types).

### Add a group mapping

The object ID of a group is on the group page in the Microsoft Entra admin center. To add a mapping, do these steps:

1. In the Microsoft Entra admin center, open **Groups** and select the group.
2. On the **Overview** page of the group, copy the **Object ID**.
3. In the portal, open **Settings → Microsoft Entra ID**.
4. Under **Group mappings**, select **Add mapping**.
5. Paste the object ID into **Group object ID**.
6. Optional: in **Group name (optional)**, enter the name of the group.
7. Under **Role** and **Scope**, select the role and the scope.
8. Select **Add mapping** and confirm with MFA.

For rights to **Settings**, the scope must be **All devices**. The group must be of the group type that Entra sends, refer to [Group types](#group-types).

### The last Owner

The portal always keeps one active Owner with a direct global assignment. If a mapping change would remove the last such assignment, the assignment stays. The audit row then contains `keptLastOwner`. For an account that Entra disabled or deleted, refer to [Account check](#account-check).

## Account check

While the sign-in is on, the portal checks the Entra accounts every 15 minutes through Microsoft Graph. It uses the client credentials of the app registration. The token stays in the memory of the portal process only.

The check includes each active Entra account of the configured tenant. Accounts of other tenants and locked accounts are not checked. A run checks at most 5000 accounts and stops after 8 minutes. The accounts that remain come first in the next run.

For each account, the portal asks Graph two questions:

- Is the account still enabled? It reads `accountEnabled` of the user.
- Is the account still in its mapped groups? It asks `checkMemberGroups` with the stored groups that have a mapping. This includes nested groups.

When Entra disabled or deleted the account, the portal locks it in the same step:

- The account gets the state **Locked**. Its sessions, MFA sessions, terminals, remote desktops, pending jobs and transfers end.
- The portal removes all stored groups and all roles from Entra. Manual role assignments stay.
- The audit gets `auth.entra.check.locked` with `state=disabled` or `state=deleted`.

When the account left one or more mapped groups, the portal removes these groups. The roles of the groups go, and the sessions of the account end. The audit gets `auth.entra.check.groups` and `auth.entra.roles.sync`.

The check never adds groups or roles. New memberships apply at the next sign-in. The check also never unlocks an account. When Entra enables the account again, an Owner selects **Unlock** in **Accounts**.

The last Owner rule applies, refer to [The last Owner](#the-last-owner). When the account has the last direct global Owner assignment, it stays active and keeps this assignment. Its sessions end. The check writes the `keptLastOwner` rows of `auth.entra.check.locked` and `auth.entra.roles.sync` one time, when this state starts.

While the state continues, each check ends the sessions of the account again but writes no new audit row. The card **Account check** shows a warning with the name of the account until the state ends. The state ends in one of two ways:

- Another account gets a direct global Owner assignment. The next check then locks the account and writes one `auth.entra.check.locked` row without `keptLastOwner`.
- Entra enables the account again. The next check then writes no row.

When Entra disables the account again later, the next check writes the `keptLastOwner` rows again.

A sign-in during the check wins over the result of Graph. The portal then checks the account again in the next run. A change of the settings stops the run.

When Graph refuses the check or cannot be reached, the run stops. The portal does not lock or change an account because of such a failure. The card shows the reason, and the audit gets one row when the result changes.

The card **Account check** on the settings page shows the state, the last and the next check, and the counts of the last run. With `MAINTENANCE_SCHEDULER=off`, the check does not run. Only one portal process or replica runs the check at a time.

## Confirm with Microsoft

An Entra account has no password, no authenticator app, no recovery codes and no passkeys. The account page shows the tenant ID, the object ID and the email instead.

Some actions need a new MFA confirmation. Examples are the terminal, PowerShell scripts of the assistant, changes of security settings and changes of rights. The Entra settings also need it. A built-in account confirms with its authenticator app or passkey. An Entra account confirms with a new Microsoft sign-in.

When the portal asks for the confirmation, the dialog shows **Confirm with Microsoft**. Do these steps:

1. Select **Confirm with Microsoft**. A Microsoft window opens.
2. Sign in again with the account that you use in the portal.
3. Wait until the window closes. The portal then continues the action.

The window opens as a pop-up. If the browser blocks pop-ups, the dialog tells you to allow pop-ups for the portal. On a phone, the window can open as a new tab. If you close the window before the sign-in is complete, the dialog tells you to try again.

The portal asks Microsoft for a new sign-in (`prompt=login`). The portal does not send `max_age`, because Entra ID then gives an ID token that expires at the sign-in time. It accepts the result only when all of these conditions are true:

- The ID token is for the same account: the same tenant ID and object ID.
- The `amr` claim of the access token contains `mfa`.
- The `auth_time` claim shows a sign-in after the start of the confirmation.
- The account is not locked, and the Entra settings did not change.

A successful confirmation gives a proof that is valid for 5 minutes. The portal uses the proof once, for the action that asked for it. The confirmation also starts a new MFA session. The primary session of the sign-in stays.

The confirmation is only for a step-up. After the idle time, the sessions of an Entra account end, and the portal shows the sign-in page with **Sign in with Microsoft**. Refer to [portal-sessions.md](portal-sessions.md#what-each-sign-in-asks-for).

### Token configuration for the confirmation

Entra ID sends `auth_time` only as an optional claim. Add it to the ID token, refer to [Configure the token claims](#configure-the-token-claims). Without this claim, each confirmation fails with the message for `staleSignIn`. Each sign-in without a live MFA grant also fails with this message.

### Conditional Access for the confirmation

Microsoft decides if a new sign-in asks for MFA again. With per-user MFA set to **Enforced**, Entra asks for MFA. The per-user MFA setting **Remember multifactor authentication on trusted devices** can skip MFA on a known device. The confirmation then fails with `mfaMissing`. Turn this setting off for the people who use the portal.

With Entra ID P1, a Conditional Access policy that requires MFA for this app also works. If MFA must run at each confirmation, set the sign-in frequency of the policy to **Every time**.

### Other limits

An Owner can lock and unlock an Entra account, as for a built-in account. A locked account cannot sign in or confirm. Name, email and password links do not apply to Entra accounts.

## Find the cause of a refused sign-in

The sign-in page and the confirmation window show only a short message. The audit log shows the details. For a sign-in, open the newest `auth.entra.login.refused` row. For a confirmation, open the newest `auth.entra.confirm.refused` row. The audit log shows each code below its label, for example **Entra sign-in refused**. Select the row to see each part of the target under **Details**.

When the reason is `tokenRejected`, the target ends with these parts:

- `check=<check>`: the check that failed. The table below gives each value.
- `error=<error>`: only for `check=callback` and `check=redeem`. It is the OAuth error code from Microsoft, for example `invalid_grant`. A code that is not in the OAuth 2.0 or OpenID Connect list shows as `other`.
- `aadsts=<number>`: only for `check=callback` and `check=redeem`, and only when Microsoft sent an AADSTS number. The part has at most 3 numbers, separated by commas. Search for the number, for example `AADSTS50076`, in the Microsoft documentation.
- `exp=<n> iat=<n> nbf=<n>`: only for the four time checks `id.expired`, `id.ahead`, `access.expired` and `access.ahead`. These are the expiry time, the issue time and the start time of the token that failed.
- `auth=<n>`: only for `id.expired` and `id.ahead`. This is the sign-in time at Microsoft (the `auth_time` claim of the ID token).
- `start=<n>`: only for the time checks of a confirmation (`auth.entra.confirm.refused`). This is the time when the confirmation started in the portal.

Each time part is an offset in seconds from the clock of the portal server at the check. A negative number is in the past, and a positive number is in the future. `none` means that the token does not have this time. An offset is a whole number from -999999999 to 999999999.

Read the time parts together:

- All offsets moved by the same amount: `iat` is far from 0, but `exp` minus `iat` is a normal token lifetime of 60 to 90 minutes. The clock of the portal server or of Microsoft is not correct.
- `iat` is near 0 or a few seconds in the past, but `exp` is in the past. Microsoft gave a token that had already expired.
- `iat` and `exp` are both long ago. The token is old, for example from a cache.
- `exp=0` or `exp` near `auth`, with `iat` and `nbf` 300 seconds before `auth`. Microsoft gave a token that expires at the sign-in time. This occurred when the request sent `max_age=0`. Report the row.
- `start` shows how long the confirmation took. Compare it with `iat` and `auth` to see if the token is from this confirmation.

An example target of a sign-in:

```text
reason=tokenRejected tenant=- object=- check=redeem error=invalid_grant aadsts=50076
```

An example target of a confirmation with an expired ID token:

```text
reason=tokenRejected user=<user> tenant=<tenant> object=<object> check=id.expired exp=-12 iat=-3612 nbf=-3612 auth=-40 start=-55
```

The row contains no text from Microsoft, no trace ID and no correlation ID. It contains no token, no code and no claim text, and no time other than the offsets. The `tenant` and `object` parts show the GUIDs from the ID token when the check came that far. Otherwise, they show `-`.

| `check` | What failed | Likely cause | What to do |
| --- | --- | --- | --- |
| `callback` | Microsoft sent an error instead of a code. | The sign-in at Microsoft failed, for example because of a Conditional Access policy. | Find the AADSTS number in the Microsoft documentation. Look at the sign-in logs of the account in the Entra admin center. |
| `code` | The answer from Microsoft had no code, or the code was longer than 8192 characters. | A proxy or a browser extension changed the address. | Make sure that the redirect URI goes directly to the portal. |
| `redeem` | Microsoft did not give tokens for the code. | The redirect URI, the credential or a policy at Microsoft. The `error` and `aadsts` parts tell which. | Test the connection. Find the AADSTS number in the Microsoft documentation. |
| `redeem.idToken` | The token answer had no ID token. | A proxy changed the answer. | Test the connection. Try again. |
| `id.format` | The ID token is not an RS256 token with a key ID, or it has a `crit` header. | A proxy changed the token. | Try again. If the error stays, report the row. |
| `id.key` | The key ID of the ID token is not in the signing keys of the tenant. | Microsoft changed its keys, or the app uses its own signing key. | Wait 5 minutes and try again. Do not set a custom signing key on the app. |
| `id.signature` | The signature of the ID token is not correct. | A proxy changed the token. | Try again. If the error stays, report the row. |
| `id.issuer` | The issuer of the ID token is not the issuer of the tenant. | The token came from another endpoint or tenant. | Make sure that the tenant ID in the settings is correct. |
| `id.audience` | The ID token is for another app. | The client ID in the settings is not the app that Microsoft used. | Make sure that the client ID in the settings is correct. |
| `id.expired` | The ID token has no expiry time, or the expiry time is in the past. The `exp` part shows how far in the past. | The clock of the portal server is too fast, or Microsoft gave an expired token. The `iat`, `nbf`, `auth` and `start` parts tell which. | When all offsets moved by the same amount, synchronize the clock of the portal server. Otherwise, report the row. |
| `id.ahead` | The `nbf` or `iat` time of the ID token is not a number, or it is more than 5 minutes in the future. The `nbf` and `iat` parts show how far. | The clock of the portal server is too slow. | Synchronize the clock of the portal server. |
| `id.nonce` | The nonce of the ID token is not the nonce of this sign-in. | An old Microsoft window, or two sign-ins in the same browser at the same time. | Close the other Microsoft windows and try again. |
| `id.oid` | The ID token has no valid object ID. | The account is not a normal account of the tenant. | Sign in with a work account of the tenant. |
| `id.groups` | The `groups` claim of the ID token is not a list. | The groups claim of the app is not set correctly. | Correct the groups claim, refer to [Configure the token claims](#configure-the-token-claims). |
| `access.format` | The access token is not an RS256 token with a key ID, or it has a `crit` or `nonce` header. | The access token is for Microsoft Graph and not for the portal API. | Make sure that the scope `access_as_user` exists under **Expose an API**. |
| `access.key` | The key ID of the access token is not in the signing keys of the tenant. | Microsoft changed its keys, or the app uses its own signing key. | Wait 5 minutes and try again. Do not set a custom signing key on the app. |
| `access.signature` | The signature of the access token is not correct. | A proxy changed the token. | Try again. If the error stays, report the row. |
| `access.issuer` | The issuer or the tenant of the access token is not the tenant of the settings. | The token came from another tenant. | Make sure that the tenant ID in the settings is correct. |
| `access.appid` | The access token was given to another app. | The client ID in the settings is not the app that Microsoft used. | Make sure that the client ID in the settings is correct. |
| `access.expired` | The access token has no expiry time, or the expiry time is in the past. The `exp` part shows how far in the past. | The clock of the portal server is too fast, or Microsoft gave an expired token. The `iat`, `nbf` and `start` parts tell which. | When all offsets moved by the same amount, synchronize the clock of the portal server. Otherwise, report the row. |
| `access.ahead` | The `nbf` or `iat` time of the access token is not a number, or it is more than 5 minutes in the future. The `nbf` and `iat` parts show how far. | The clock of the portal server is too slow. | Synchronize the clock of the portal server. |
| `access.identity` | The access token is for another account or tenant than the ID token. | A proxy changed the answer. | Try again. If the error stays, report the row. |

Some answers from Microsoft are not a refused token. The person can try again:

- The callback error `server_error` or `temporarily_unavailable` gives the message for `unavailable`. Microsoft had a temporary failure.
- The token error `invalid_grant` with AADSTS54005 or AADSTS70008 gives the message for `expired`. The code was already used, or it expired.

These cases write no audit row.

## Emergency access

The emergency access is one built-in Owner account that can sign in when Microsoft is not available. It keeps its password and its second factor. Choose it before you switch to Microsoft sign-in only.

An account can be the emergency access only when all of these conditions are true:

- It is a built-in account, not an Entra account.
- It is active and has a password. It does not have to set a new password.
- It has two-factor sign-in: an authenticator app or a passkey.
- It has a direct assignment of the built-in role **Owner** for **All devices**. An assignment through a user group or a device group does not count.

To choose the account, do these steps:

1. Open **Settings** › **Microsoft Entra ID**.
2. In the card **Emergency access**, select the account.
3. Select **Save emergency access** and confirm with MFA.

The list shows only the accounts that qualify. When no account qualifies, the card says what to set up. The portal checks the conditions again when it saves the choice.

While Microsoft sign-in only is on, the emergency access is fixed. To choose another account, allow built-in accounts again first. While it is on, the emergency access cannot lose what it needs:

- No one can lock the account.
- No one can remove or change its direct **Owner** assignment for **All devices**.
- No one can remove its last second factor. Add another method before you remove one.

A password change, a new authenticator app, a new passkey and a password link from an Owner still work.

The emergency access never gets or uses an MFA grant while Microsoft sign-in only is on. Each emergency sign-in needs the password and the second factor, refer to [portal-sessions.md](portal-sessions.md#what-each-sign-in-asks-for).

### Emergency sign-in

Each sign-in of the emergency access while Microsoft sign-in only is on is an emergency sign-in. The portal writes these items in the same step as the new session:

- A critical security alarm with the account, the time and the client address. The portal stores an IPv6 address as its /64 network. Without a known address, the alarm shows "an unknown address".
- A notification to all Owners, refer to [notifications.md](notifications.md#emergency-sign-ins).
- The audit row `auth.emergency.login` with the account, the address and the alarm ID.

A confirmation with MFA and a new MFA check of a running session are not emergency sign-ins. A sign-in while Microsoft sign-in only is off is also not an emergency sign-in.

The console of each Owner shows the alarm until an Owner acknowledges it. The notice names the account, the time and the address. It counts the other open alarms and links to the audit log. Select **Acknowledge** to close the alarm. The emergency access cannot acknowledge its own alarm. Another Owner must do it, so the person who used the emergency access cannot hide it.

The card **Emergency access** shows the account, its second factors, the last emergency sign-in and the number of open alarms.

### Recover the emergency access

When the emergency access loses its authenticator app, sign in with a passkey or a recovery code. When no factor is left, a server operator can reset the authenticator apps with `reset-totp`. Refer to [self-hosting.md](self-hosting.md#after-a-leak-of-the-session-secret). The command deletes the authenticator apps of all accounts. The emergency access then sets up MFA again at its next sign-in.

## Microsoft sign-in only

When Microsoft sign-in only is on, people sign in only with Microsoft. The portal locks all built-in accounts except the emergency access.

The card **Microsoft sign-in only** shows these checks under **Before you switch**:

- Sign-in with Microsoft is on, and the connection test passed for the current settings.
- An emergency access account is chosen, and it still qualifies.
- You are signed in with Microsoft, and your account is an Owner for all devices.
- An email channel can notify the Owners about emergency sign-ins. This check only warns. Without an email channel, Owners see emergency sign-ins only in the portal.

The first three checks must pass. A built-in Owner cannot make the switch. Sign out, then sign in with Microsoft with an Entra account that has the role **Owner**. This sign-in shows that Owners can still sign in after the switch.

To switch, do these steps:

1. Select **Switch to Microsoft sign-in only**.
2. Read the dialog. It shows the number of built-in accounts to lock and the emergency access.
3. Select **Switch to Microsoft sign-in only** in the dialog.
4. Sign in again in the Microsoft window, refer to [Confirm with Microsoft](#confirm-with-microsoft).

The portal checks all conditions again when it saves the switch. If a condition changed, it changes nothing.

### What the switch does

In one step, the portal does these changes:

- Each other built-in account that is active or invited gets the state **Locked**. Its open invitation and password links become invalid.
- The sessions, MFA sessions and MFA grants of these accounts end. The sessions of the emergency access also end.
- The audit gets `auth.entra.only.on` with the emergency access and the number of locked accounts. It also gets one `auth.user.disable` row for each locked account.

The portal deletes no account, no role assignment and no audit row. The audit log still shows the old names of the locked accounts. Entra accounts and your own session do not change.

While Microsoft sign-in only is on, these rules apply:

- The sign-in page shows **Sign in with Microsoft** as the only main action. The password form opens with **Use emergency access**.
- Only the emergency access can sign in with a password. Other built-in accounts get the message for wrong credentials, so the page does not show if an account exists.
- No one can create a built-in account or unlock a built-in account. Invitation links do not work.
- Entra accounts can be locked and unlocked as before.

### Sign-in with Microsoft off

You can turn off sign-in with Microsoft while Microsoft sign-in only is on. A change of the tenant, the client ID or the credential also turns it off. Then only the emergency access can sign in. Before you turn the switch off, the portal asks you to confirm. The card **Microsoft sign-in only** shows a warning until sign-in with Microsoft is on again.

To get back, sign in with the emergency access. Test the connection, turn on the sign-in, and sign in with Microsoft as an Owner.

### Allow built-in accounts again

Select **Allow built-in accounts again** and confirm with MFA. Any Owner can do it, also the emergency access. The audit gets `auth.entra.only.off`.

The emergency access stays chosen. The locked accounts stay locked. To unlock an account, an Owner selects **Unlock** in **Accounts**.

## Troubleshooting

### An account signs in but sees no settings and no devices

A person signs in with Microsoft, and a group mapping gives the role **Owner** for **All devices**. The console still shows no **Settings** and no devices.

The usual cause is an ID token without a groups claim. The portal then stores no groups and gives no role from a mapping. This is not an error, thus the sign-in succeeds.

To correct the problem, do these steps:

1. Add the groups claim for the ID token, or correct it, refer to [Configure the token claims](#configure-the-token-claims).
2. Tell the person to sign out and sign in with Microsoft again.
3. Check the role as in [Check the setup](#check-the-setup).

The portal reads the groups only at sign-in. The account check never adds groups or roles, refer to [Account check](#account-check). Thus a correction in Entra applies only at the next sign-in. A correction of a mapping applies at once, because the portal uses the stored groups.

### Other causes with the same symptom

These causes also give an account without rights. Each item tells the correction:

- The groups claim is only on the access token or on the SAML token. Add the **ID** token to the groups claim.
- The group type is **Groups assigned to the application**, and the mapped group is not assigned. Assign the group, refer to [Assign the groups to the application](#assign-the-groups-to-the-application).
- **Emit groups as role claims** is on. Entra then sends the groups in the `roles` claim. Clear this option for the **ID** token.
- The format is not **Group ID**, for example `sAMAccountName`. The portal ignores each value that is not a GUID. Select **Group ID** for the **ID** token.
- The mapped group is not of the selected group type, refer to [Group types](#group-types). Map a group of this type, or select a different type.
- The mapping has a wrong object ID. Compare it with the **Object ID** on the **Overview** page of the group. Remove the mapping and add it again with the correct ID.
- The mapping has a scope other than **All devices**. The rights to **Settings** need **All devices**. Remove the mapping and add it again with **All devices**.
- The person is in no mapped group. Such an account has no rights, refer to [Group mappings](#group-mappings).

After a correction in Entra, the person must sign out and sign in with Microsoft again.

A refused sign-in is a different problem. The sign-in page then shows a message, and the audit gets `auth.entra.login.refused`. For `groupsOverage`, refer to [Group mappings](#group-mappings). For `mfaMissing`, refer to [MFA](#mfa). For `apiSetupMissing`, refer to [Sign in](#sign-in). For `tokenRejected`, refer to [Find the cause of a refused sign-in](#find-the-cause-of-a-refused-sign-in).

### Sign-in with Windows Hello fails

On a Windows device, the Microsoft window can ask for the Windows Hello PIN. If the portal then shows the message for `tokenRejected`, do these steps:

1. Open the audit log.
2. For **Sign in with Microsoft**, find the newest `auth.entra.login.refused` row.
3. For **Confirm with Microsoft**, find the newest `auth.entra.confirm.refused` row.
4. Read the `check`, `error` and `aadsts` parts. Find the `check` value in [Find the cause of a refused sign-in](#find-the-cause-of-a-refused-sign-in).

The problem can occur only sometimes. Write down the values of each failed sign-in. They show if the cause is always the same.

## Audit

The portal writes these audit actions. No row contains a secret, a token or a code.

| Action | When |
| --- | --- |
| `auth.entra.settings.update` | The settings were saved. |
| `auth.entra.settings.test` | The connection was tested. |
| `auth.entra.enable`, `auth.entra.disable` | The sign-in was turned on or off. |
| `auth.entra.mapping.add`, `auth.entra.mapping.remove` | A group mapping was added or removed. |
| `auth.entra.account.create` | A first sign-in created an account. |
| `auth.entra.login` | A person signed in with Microsoft. |
| `auth.entra.login.refused` | A sign-in failed after a valid start. The target names the reason, the tenant and the object. For `mfaMissing`, it also names the `amr` values. For `apiSetupMissing`, it names the `detail`. For `tokenRejected`, it names the `check` and, for a time check, the time offsets. Refer to [Find the cause of a refused sign-in](#find-the-cause-of-a-refused-sign-in). |
| `auth.entra.roles.sync` | The roles of an account changed because of its groups. |
| `auth.entra.check.locked` | The account check locked an account that Entra disabled or deleted. The target names the account, the tenant, the object and the state. |
| `auth.entra.check.groups` | The account check removed the groups that an account left. The target names the removed groups. |
| `auth.entra.check.failed` | The account check changed to a failure. The target names the result code. |
| `auth.entra.check.restored` | The account check works again after a failure. |
| `auth.entra.confirm` | An Entra account confirmed with Microsoft. The target is the account ID. |
| `auth.entra.confirm.refused` | A confirmation failed after a valid start. The target names the reason, the account, the tenant and the object. For `mfaMissing`, it also names the `amr` values. For `apiSetupMissing`, it names the `detail`. For `tokenRejected`, it names the `check` and, for a time check, the time offsets. Refer to [Find the cause of a refused sign-in](#find-the-cause-of-a-refused-sign-in). |
| `auth.entra.emergency.set` | An Owner chose the emergency access. The target is the account ID. |
| `auth.entra.only.on` | Microsoft sign-in only was turned on. The target names the emergency access, the number of locked accounts and the settings revision. |
| `auth.entra.only.off` | Built-in accounts are allowed again. |
| `auth.emergency.login` | The emergency access signed in while Microsoft sign-in only is on. The target names the account, the client address and the alarm ID. |
| `auth.emergency.acknowledge` | An Owner acknowledged an emergency sign-in alarm. The target is the alarm ID. |
