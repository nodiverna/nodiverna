# Notifications

Notifications tell technicians about alarms without the portal. The portal
sends alarm changes to channels: email over SMTP, Microsoft Teams, Discord and
a signed webhook. Notification rules on **All devices**, on a device group and on a
customer decide which alarms go to which channel. The alarms themselves come
from the alert rules. Refer to [Alert rules](alert-rules.md).

## The permission and the MFA session

The page **Settings → Notification channels** needs the portal permission
**Manage notification channels** (`portal.notifications.manage`). This permission is
global. Owners have it through `*`. The built-in roles Reader and Operator do
not have it. The same permission is necessary for the delivery log.

The page has two tabs: **Channels** and **Delivery log**. The link
`#settings/notification-channels/log` opens the delivery log. **Add channel** is
at the top of the page and opens the form on each tab. Each row of the channel
table has a menu with **Send test message**, **Edit**, **Turn on** or **Turn
off**, **Generate new signing secret** (webhook only) and **Delete**.

A change of a channel needs no new MFA confirmation. This applies to add, edit,
turn on or off, delete, **Generate new signing secret** and **Send test
message**. Notification changes have a low impact. Each change needs the live
MFA login session and the permission. If the session ends before the change is
written, the portal writes nothing and asks you to sign in again. Refer to
[Portal sessions](portal-sessions.md#which-actions-ask-for-mfa-again).

Each change writes one entry in the portal audit log. The entry names the
channel and the changed fields with their old and new values. Examples are the
sign-in, the tenant ID, the client ID and the service account. A changed secret
shows only as `"secretChanged":true`.

## Channels

Each channel has a name, a type, a language for its messages and a switch. Names
are unique without regard to case. A channel that is off gets no messages.

### Email (SMTP)

Each email channel has a **Sign-in**. It decides how the portal sends the
messages and which fields the channel has:

- **Password**: a user name and a password, or an app password. This sign-in
  works with each SMTP server.
- **Microsoft 365**: the portal sends through Microsoft Graph with an app
  registration in Microsoft Entra ID. No password is necessary.
- **Google Workspace**: the portal sends through Gmail with a service account.
  No password is necessary.

You can change the sign-in of a channel. A new sign-in needs its own secret. The
portal then deletes the secret of the old sign-in. All sign-ins have these fields:

- **Sender**: one address. **Recipients**: 1 to 20 addresses, separated with
  commas.

The message has a plain text part and a simple HTML part, both in UTF-8. Through
Microsoft Graph, the message has only the HTML part.

#### Sign-in: Password

- **SMTP server** and **Port**: a host name or an IP address, port 1 to 65535.
- **Encryption**: **TLS** opens the connection with TLS. **STARTTLS** needs the
  STARTTLS command and fails when the server does not offer it. **None** sends
  plain text.
- **Username** and **Password**: optional. With **None** the portal does not
  accept a user name or a password, so no credentials go over plain text.

The portal checks the certificate of the server against the host name.

An account with multi-factor authentication (MFA) does not accept its normal
password over SMTP. The test message then shows `authMfaRequired`: "The account
uses multi-factor authentication, so the server refuses the password." Use one
of these solutions:

- Microsoft 365: select the sign-in **Microsoft 365**. App passwords work only
  for accounts with per-user MFA. Microsoft is retiring basic authentication for
  SMTP AUTH, so app passwords will stop working.
- Google: select the sign-in **Google Workspace**. For a personal Gmail account,
  turn on 2-Step Verification and make an app password. Enter the app password
  in **Password**.

#### Sign-in: Microsoft 365

The portal sends through the Microsoft Graph `sendMail` API, not through SMTP.
Microsoft is retiring basic authentication for SMTP AUTH. SMTP with OAuth also
needs SMTP AUTH on each mailbox and more setup in PowerShell. Graph needs only
one permission and works also when the tenant turns SMTP AUTH off.

Set up the app in the Microsoft Entra admin center:

1. Open "Identity → Applications → App registrations" and select "New
   registration".
2. Enter a name, for example `Nodiverna notifications`. Keep "Single tenant"
   and select "Register".
3. Open "API permissions", select "Add a permission" and then "Microsoft Graph".
4. Select "Application permissions", then `Mail.Send`, then "Add permissions".
5. Select "Grant admin consent" for your tenant.
6. Open "Certificates & secrets" and select "New client secret".
7. Copy the "Value" of the secret at once. Write down its expiry date.

Then fill in the channel:

| Field | Value |
|---|---|
| **Tenant ID** | "Directory (tenant) ID" of the app, or the primary domain, for example `contoso.onmicrosoft.com` |
| **Application (client) ID** | "Application (client) ID" of the app |
| **Client secret** | The "Value" of the client secret |
| **Sender** | An existing mailbox of your organization. The messages come from it. |

Make a new client secret before the old one expires. Enter it in **Client
secret**. An empty field keeps the stored secret.

Security note: `Mail.Send` as an application permission lets the app send as
each mailbox of the tenant. Limit the app to the sender mailbox. Use RBAC for
Applications in Exchange Online, or an application access policy.

#### Sign-in: Google Workspace

The portal uses a service account with domain-wide delegation. It sends over
SMTP to `smtp.gmail.com` on port 465 with TLS and the XOAUTH2 sign-in. The
sender must be a user of your Google Workspace.

1. In the Google Cloud console, open "IAM & Admin → Service accounts".
2. Select "Create service account" and enter a name.
3. Open the service account, then "Keys → Add key → Create new key".
4. Select "JSON" and "Create". The browser downloads the key file.
5. Copy the "Unique ID" (client ID) of the service account.
6. In the Google Admin console, open "Security → Access and data control → API controls".
7. Open "Manage Domain Wide Delegation" and select "Add new".
8. Enter the client ID and the scope `https://mail.google.com/`, then select "Authorize".

Then fill in the channel. Paste the key file into **Service account key (JSON)**,
or select **Choose key file**. The file can have at most 16 KiB. The portal
keeps the private key, its ID and the address of the service account. It
ignores the other fields of the file. An empty field keeps the stored key.

#### Sign-in errors

| Error | Fix |
|---|---|
| "The sign-in was refused. Check the user name and password. If the account uses multi-factor authentication, use an app password." (`authFailed`) | Check the user name and the password. For an account with MFA, use an app password. |
| "The account uses multi-factor authentication, so the server refuses the password." (`authMfaRequired`) | Use an app password, or select the sign-in **Microsoft 365** or **Google Workspace**. |
| "The server does not accept a sign-in with a password." (`authBasicDisabled`) | For Microsoft 365, select the sign-in **Microsoft 365**. For another server, ask its administrator to allow SMTP AUTH. |
| "Microsoft refused the sign-in of the app." (`microsoftSignInRefused`) | Check **Tenant ID**, **Application (client) ID** and **Client secret**. |
| "The client secret has expired." (`microsoftSecretExpired`) | Make a new client secret in the app registration and enter it in **Client secret**. |
| "Microsoft Graph refused to send from this mailbox." (`microsoftPermissionMissing`) | Give the app the application permission `Mail.Send` with admin consent. Make sure that its access includes the sender mailbox. |
| "Google refused the service account key." (`googleSignInRefused`) | Make sure that the key and the service account are active, or make a new key. |
| "Google refused to send as the sender." (`googleDelegationMissing`) | Allow domain-wide delegation for the client ID of the service account with the scope `https://mail.google.com/`. |
| "The sender mailbox was not found." (`mailboxNotFound`) | Enter the address of an existing mailbox of your organization in **Sender**. |

### Microsoft Teams

Create a workflow in Teams with the trigger "When a Teams webhook request is
received". Copy its URL into **Workflow URL**. The portal sends an Adaptive
Card. The URL must start with `https://` and must not contain a user name or a
password.

### Discord

In Discord, open **Server Settings → Integrations → Webhooks**. Select a webhook
or make a new one, then select **Copy Webhook URL**. Paste the URL into
**Webhook URL**.

The portal accepts only a Discord webhook URL:

- The URL starts with `https://` and has no port.
- The host is `discord.com`, `discordapp.com`, `ptb.discord.com`,
  `canary.discord.com`, `ptb.discordapp.com` or `canary.discordapp.com`.
- The path is `/api/webhooks/<ID>/<token>` or `/api/v<number>/webhooks/<ID>/<token>`.
  The ID has only digits. The token has only letters, digits, `_` and `-`.
- A query string is possible, for example `?thread_id=123`.

For each alarm the portal sends one embed. The embed has the heading, a link to
the alarm history, the facts, the time and a color for the level. A closed alarm
is green. A bundle has the subject as text and at most 10 embeds. It gives the
number of the other changes.

Mentions are off, so a name such as `@everyone`
does not notify a person. Markdown characters in names show as text.

The types **Webhook** and **Microsoft Teams** refuse a Discord webhook URL. Add a
channel of the type **Discord** for it.

### Webhook

The portal sends a `POST` request with a JSON body to **Webhook URL**. The URL
must start with `https://`. The portal makes a signing secret of 32 random
bytes. The page shows the secret one time after you add the channel. It shows a
new secret one time after **Generate new signing secret**. Copy it at that
time with the copy button.

**Generate new signing secret** asks for a confirmation first. The current
secret stops working at once. The receiver refuses messages until you enter the
new secret there. **Cancel** sends nothing.

Each request has these headers:

| Header | Value |
|---|---|
| `X-Nodiverna-Event` | `alert.open`, `alert.escalate`, `alert.close`, `alert.bundle` or `test` |
| `X-Nodiverna-Delivery` | The ID of the message |
| `X-Nodiverna-Timestamp` | The time of the request in Unix seconds |
| `X-Nodiverna-Signature` | `v1=` and the hex HMAC-SHA256 of the timestamp, a dot and the body |

To check a request, calculate the HMAC with your secret. Compare it with the
header in constant time. Refuse old timestamps, for example older than five
minutes.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verified(secret, headers, rawBody) {
  const timestamp = headers['x-nodiverna-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const received = String(headers['x-nodiverna-signature'] ?? '');
  return received.length === expected.length && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
```

Each entry of the body has these fields: `event`, `alertId`, `level`, `device`
(`id`, `name`), `customer` (`id`, `name` or `null`), `rule` (`id`, `name`),
`key`, `value`, `threshold`, `unit`, `closeReason`, `occurredAt` and `url`.

### Secrets

The portal keeps these secrets encrypted with `SESSION_SECRET`:

- the SMTP password
- the client secret of Microsoft 365
- the service account key of Google Workspace
- the Teams URL, the Discord URL and the webhook URL
- the signing secret of a webhook

No answer, audit entry, log line or
message contains them. The page shows a stored secret only as "Stored – leave
empty to keep". An empty field keeps the stored value. After a change of
`SESSION_SECRET`, `rewrap-secrets` encrypts these values again. Refer to
[Self-hosting](self-hosting.md).

The sign-ins **Microsoft 365** and **Google Workspace** use access tokens. An
access token is valid for about one hour. The portal keeps the tokens only in
memory and gets new tokens automatically. After a restart, the first message
gets a new token.

### Test message

**Send test message** sends one message without alarm data through the channel.
It also works on a channel that is off. The page shows the error when the test
fails, for example "The sign-in was refused. Check the user name and password.
If the account uses multi-factor authentication, use an app password."

The delivery log keeps the test. Each test also writes one entry in the portal
audit log with the channel and the result. A failed test also gives the error.

You can send at most 5 test messages in 60 seconds, for all channels together.
The portal refuses more tests with "Too many test messages in a short time. Try
again in one minute."

## Targets, time limits and retries

Before each connection the portal resolves the host. Each address must be
allowed. The connection then goes to the checked address, so a second DNS
answer cannot change the target. The portal never follows a redirect.

These targets are always refused:

- loopback, unspecified and link-local addresses, which include `169.254.169.254`
- `fd00:ec2::254`, `100.100.100.200`, multicast and broadcast addresses
- the documentation ranges `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`,
  `2001:db8::/32` and `3fff::/20`
- the benchmark range `198.18.0.0/15`
- the 6to4 ranges `192.88.99.0/24` and `2002::/16`, and the Teredo range
  `2001::/32`
- the IPv4-mapped forms of these addresses
- the host names `localhost` and `metadata.google.internal`

The sign-ins **Microsoft 365** and **Google Workspace** connect to fixed hosts:
`login.microsoftonline.com`, `graph.microsoft.com`, `oauth2.googleapis.com` and
`smtp.gmail.com`. These connections go through the same target check.

Private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
`100.64.0.0/10` and `fc00::/7`) are refused by default. Set
`NOTIFY_ALLOW_PRIVATE_TARGETS=true` to allow them, for example for an internal
SMTP relay.

The DNS lookup has 3 seconds. If there is no answer in this time, the attempt
fails with "The server name could not be resolved" and can get a new attempt.

A connection has 5 seconds to open and 10 seconds in total. A request body has
at most 64 KiB, for Teams 24 KiB. The portal reads at most 16 KiB of an answer.
A send has up to three attempts, after 1 second and after 4 seconds. Network
errors, time-outs, HTTP 408, 429 and 5xx, and SMTP 4xx replies get a new
attempt. Other errors do not.

HTTP 400 and 422 get no new attempt. The target refused the format of the
message. The test message and the delivery log then show "The target refused
the message (status 400). Check that the channel type fits the target: a
Discord webhook needs the type Discord." For example, a Discord webhook URL in
a channel of the type **Webhook** gives this error.

## Notification rules

The page **Monitoring → Notification rules** is on **All devices**, on each device group and on
each customer (`…/monitoring/notification-rules`). The customer page shows when the portal has more than one
customer. With the right to manage notification channels, the head of the page has **Open notification channels**
and **Open delivery log**. A rule names a channel, one or more levels and one or more events:

- **Opened**: an alarm opens.
- **Escalated to a higher level**: the level of an open alarm goes up, for
  example from warning to critical.
- **Closed**: an alarm closes, with its reason.

The rules of a device add up. The rules of **All devices**, of its customer and
of each of its groups and parent groups all apply. A channel gets one message
per alarm change, also when more rules match. Rules and channels that are off
match nothing. A scope has at most one rule per channel.

A device has no notification rules of its own. **Monitoring → Notification rules** of a device
(`#device/<id>/monitoring/notification-rules`) shows the rules that reach the device: the rules of its group and
the parent groups, of its customer (when the portal has more than one customer) and of **All devices**. The nearest
origin comes first.

Each row shows its origin. You cannot change a rule there: **Open origin** opens the page
where you can change it. When no rule reaches the device, **Open notification rules of** opens the page of its
group, or of **All devices**.

The page shows two cards. The card **Direct** shows the rules of this scope.
The card **Inherited** shows the rules of higher levels, nearest origin first,
with a link to their origin. It shows only when such rules exist. Change an
inherited rule at its origin.

To add a rule, select **Add notification rule** above the cards. To delete a
direct rule, open its row menu and select **Delete**. Then confirm with
**Delete rule**.

When the card **Direct** has no rule, it tells you why and what to do next:

- No channel exists yet: **Open notification settings** opens the channel
  settings. Without **Manage notification channels**, ask an administrator.
- No rule applies: **Add notification rule** opens the form.
- Sample devices: **Hide sample devices** shows your own devices again. Sample
  devices have no channels and no rules.

To change rules on a group, you need **Manage alert rules and alarms**
(`alerts.manage`) on that group. On a customer, you need this permission for all
devices and you must see the customer. On **All devices**, you need it for all
devices and you must see all customers. Each change writes one audit entry.
Users without **Manage notification channels** can select existing channels,
but they never see the settings of a channel.

## When a message is not sent

The server decides once for each alarm change. It does not send a skipped change
later. The delivery log shows the reason:

- **Suppressed: alarm muted**: the alarm was muted at the time of the change.
- **Suppressed: maintenance window**: the change happened in the maintenance
  window of the customer of the device.
- **Suppressed: opening was not sent**: an escalation or a close goes only to
  channels that got an earlier message of the same alarm.
- **No matching rule**: no rule matches the level and the event.
- **Suppressed: no recipient**: an emergency sign-in found no channel and no
  Owner address, refer to [Emergency sign-ins](#emergency-sign-ins).

An escalation or a close waits until the earlier message of its alarm is sent
or failed.

## Bundles and delivery

The portal sends once a minute, after the alarm check. All changes for one
channel go out as one message. One change gives a single message, for example
"[Critical] Disk space low on WEB01". Two or more changes give one bundle, for
example "12 alarm changes on 5 devices". A bundle lists at most 25 changes (on
Discord 10), the most severe first, and gives the number of the others. A message that is too
large for its channel gets fewer entries.

A message names the event, the level, the device, the rule, the value and the
threshold with their units and the time. It names the customer when the portal
has more than one customer. A link opens the alarm history of the device. A message
never contains tokens, secrets, IP addresses or the names of users.

A failed message gets two more runs: after 1 minute and after 5 more minutes.
After the third failed run it is failed. A message that the target refused
with HTTP 400 or 422 gets no more runs and is failed at once. A failure on one channel does not
stop the others. With `MAINTENANCE_SCHEDULER=off` the portal sends no
notifications.

## Emergency sign-ins

An emergency sign-in is a sign-in of the emergency access while Microsoft
sign-in only is on, refer to [entra-id.md](entra-id.md#emergency-access). It
sends a critical message to all Owners. The portal sends it once. Notification
rules, mutes and maintenance windows do not apply:

- The oldest enabled email channel sends one email to the Owners. The
  recipients are the addresses of all active accounts with a direct assignment
  of a role with all rights, for example **Owner**, for **All devices**.
  Built-in and Entra accounts count.
- The portal writes the addresses in lower case, removes duplicates, sorts
  them and uses at most the first 20. The recipients of the channel itself do
  not get this email. Owners without an email address see only the alarm in the
  portal.
- Each enabled Teams, Discord and webhook channel also gets the message when it
  has an enabled rule for **All devices** with the level **Critical**.

Without such a channel or without an Owner address, the delivery log shows
**Suppressed: no recipient**.

The message always goes out alone, never in a bundle. It names the portal, the
account, the exact time in UTC and the client address. It tells the Owners to
check the audit log and to change the password of the emergency access if the
sign-in was not planned. A link opens the audit log. This is the only message
with the name of a person and an address. It never contains a password, a
token, a session or a second factor.

Retries and failures follow the rules above. A retry sends to the same
addresses as the first run. The delivery log shows **Emergency access used**
in the device column.

## Delivery log

The tab **Delivery log** shows each message with its time, event, device,
alarm, channel, target, status and attempts. Filter it by **Sent**, **Failed**
or **Suppressed**. When no entry has the status, **All** removes the filter.
**Load more** below the table shows older entries. The log shows only the devices that you can see, every
test message and every emergency sign-in. A deleted channel keeps its log entries with its name and type.

The maintenance deletes log entries with the alarm retention (`--alert-days` or
`ALERT_RETENTION_DAYS`, by default 90 days). Entries that wait to be sent stay.
