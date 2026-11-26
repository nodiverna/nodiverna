# Data for product improvement

## Status in this version: off

In this version, the function is off. ServerDesk sends no usage data and shows
no notice to Owners. The page **Settings → Usage data** shows the card locked
and blurred under a notice. The maintenance result is
`usageReport: {"status":"disabled"}`. This is also true when
`LICENSE_SERVER_URL` is set and an Owner agreed before.

Developers turn the function on in `usageDataEnabled` in
`runtime/usage-report.mjs`. This function is the only switch. The rest of this
file describes the behavior when the function is on.

## Overview

One time each day, ServerDesk can send some technical values to a usage data
server. With these values, the manufacturer knows how many installations run,
with which version and with how many devices. The values do not identify
persons. Global Owners control the function on the page **Settings → Usage data**.

## What ServerDesk sends

ServerDesk sends exactly this JSON object and nothing more:

```json
{
  "schema": 2,
  "instanceId": "3f9c2a0d8b7e41c6a5d90e1f2b3c4d5e",
  "version": "0.1.0",
  "deviceCount": 12
}
```

| Field | Content |
|---|---|
| `schema` | Format version of this message, at this time `2`. Version `1` also had a field for the edition. |
| `instanceId` | Random instance ID, refer to the section below. |
| `version` | `version` from `ServerDesk/package.json` if it has the form `1.2.3` (optionally with `-…` or `+…`), otherwise `unknown`. |
| `deviceCount` | Managed devices of all customers: rows in `servers` with `revoked=0`. |

ServerDesk never sends these items:

- names, email addresses, user names and host names
- IP addresses of the devices and `SITE_ORIGIN`
- customers, and contents or data of the devices
- the person who changed the setting, and timestamps

For each additional value, a new check must show that the decision of the
Owner still covers it.

## Notice and withdrawal

- After the first setup, the first Owner sees the notice
  **Data for product improvement**. It shows
  directly after the password and MFA. It shows the three values with their
  current contents. Nothing is selected before.
- The notice has two buttons
  of the same weight: **Don't send** and **Send usage data**. The first focus
  is on **Don't send**, so the Enter key sends no data. Each button saves
  the decision.
- If the Owner closes the notice without a button, there is no decision yet,
  and ServerDesk sends nothing. The notice shows again at the next load of the
  console. It shows only to global Owners, also with sample devices.
- Each Owner can change the decision later on the page
  **Settings → Usage data** (`#settings/usage-data`), in the
  card **Data for product improvement**. The old link `#settings/license` opens
  this page too. The switch **Send usage data** saves
  at once, without an MFA prompt. The card also shows the time of the last
  transmission or the reason why the last attempt failed.
- While no usage data server is set up, or while its address is invalid, the
  switch is locked and shows the reason. It shows off. If the saved decision
  is "send", the card says so and shows **Don't send**. Thus the Owner can
  always withdraw the decision.
- The portal log records each change as `Datensammlung eingeschaltet` (data
  collection on) or `Datensammlung ausgeschaltet` (data collection off).

The table `usage_data` (one row) keeps the decision. `consent` is `NULL` (no
decision yet), `1` (send) or `0` (do not send). ServerDesk sends only when the
value is `1`.

For Owners, the API `GET /api/usage-data` returns
`{enabled, consent, decidedAt, revision, server, lastAttemptAt, lastSuccessAt, lastError, payload}`.
`enabled` is `false` while the function is off. `server` is `none`, `invalid`
or `configured`. The response does not contain the address itself or the
account that made the decision.

`POST {action:'set', enabled, revision}` changes the decision. An old
`revision` gives 409. Other accounts get 403. While the function is off, an
Owner also gets 409 (`apiError.settings.usageUnavailable`), and ServerDesk
writes nothing.

## When ServerDesk sends

The portal process sends the data from its daily maintenance (refer to the
maintenance section in [`self-hosting.md`](self-hosting.md#maintenance)). A
lock in the database lets only one run occur at a time. Thus the report goes
out a maximum of one time in 20 hours, and only one time also with many
replicas. A request of a user never sends the report.

0. While the function is off, nothing occurs (`usageReport: {"status":"disabled"}`).
   There is no network access and no database read or write.
1. Without `LICENSE_SERVER_URL`, nothing occurs. There is no network access and
   no database read or write (`usageReport: {"status":"no-server"}`).
2. ServerDesk does not use an address that is not valid (`invalid-server`,
   warning on stderr).
3. Without consent (`consent` is not `1`), ServerDesk sends nothing
   (`no-consent`).
4. There is a maximum of one attempt in 20 hours (`not-due`). The value is 20
   hours and not 24 hours, so that a change of the daily time has no effect. A
   run claims the attempt atomically in the database. Two runs at the same time
   send a maximum of one time.
5. Result: `sent` for a 2xx response, otherwise `failed` with `http-<Status>`,
   `timeout` (after 10 seconds) or `network`. A failed attempt also becomes due
   again only after 20 hours.

The report never changes the status of the maintenance run. It never writes
the payload or the address into an output or a log.

## `LICENSE_SERVER_URL`

This is the address that gets the usage report, as an environment variable of
the portal app (NAS: `.env.runtime`, Azure: environment variable of the web
app). The manufacturer sets no default address. A valid
value is an absolute URL with these properties:

- It uses `https:`. `http:` is permitted only for `localhost`, `127.0.0.1` and
  `[::1]` (the same as `SITE_ORIGIN`).
- It has no user name and no password.
- It has no query (`?…`) and no fragment (`#…`).

A path is permitted. ServerDesk adds `v1/usage` to the base, with a `/` at the
end of the base:

| `LICENSE_SERVER_URL` | Endpoint |
|---|---|
| `https://lizenz.example.com` | `https://lizenz.example.com/v1/usage` |
| `https://example.com/serverdesk/` | `https://example.com/serverdesk/v1/usage` |

## What the usage data server must do

- Accept `POST <Basis>/v1/usage` with `Content-Type: application/json`,
  `User-Agent: ServerDesk/<version>` and the JSON from above.
- Answer with a 2xx status. ServerDesk does not read the response body and does
  not follow a redirect. A redirect counts as an error (`network`).
- Discard the IP address of the request and do not keep it. Each HTTP request
  sends the public IP address of the installation, and this address can
  identify a person. ServerDesk does not send it in the payload. The usage
  data server must also not keep it from the connection.
- This version calls no other endpoint.

## The instance ID

The baseline migration `0000_baseline.sql` makes the ID one time with
`replace(gen_random_uuid()::text,'-','')`. The result is 32 hexadecimal characters, random
and not derived from other data. The ID never changes, also not after a
withdrawal. A copied or restored database keeps the ID. This is intentional,
because it is the same installation. If you operate a copy as a separate
installation, it reports the same ID as the original.
