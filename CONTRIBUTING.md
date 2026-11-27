# Contributing to ServerDesk

Thank you for your help with ServerDesk. Read all of this page before you open a pull request. We merge a contribution only when you submit it under the [contribution terms](#contribution-terms).

## Workflow

1. Prepare the environment as the [README](README.md#run-from-source) tells you.
2. Before you open the pull request, run the full check in `ServerDesk/`:

   ```powershell
   node scripts/pipeline.mjs verify
   ```

   The check examines types, lint, tests, the production build and the HTTP integration. All parts must pass.

   On each push to `dev` and on each pull request, `.github/workflows/ci.yml` runs the typecheck, lint, tests, audit and `pnpm test:http`. It also runs the dependency audit one time each day.

   On Windows, pnpm with administrator rights makes directory symlinks in `node_modules` instead of junctions. Then the build and `pnpm test:http` fail with EPERM. `pnpm build` and `pnpm test:http` detect this problem before they start. To repair it, run `node scripts/check-node-modules-links.mjs --fix`. As an alternative, install again without administrator rights.
3. The complete product is in this repository, also the customer functions. `pnpm test` runs all of its tests.
4. All text files have LF line endings in the repository and in the working tree, also on Windows (`.gitattributes`). Did you clone the repository before this rule? Then do a new checkout one time. First, commit or save your changes. Then run `git rm -r --cached -q .` and after it `git reset --hard`. `pnpm test` reports files with CR.
5. The database is PostgreSQL 17. To change the schema, follow these steps:
   1. Change `ServerDesk/db/schema.ts`.
   2. Run `pnpm db:generate`. It writes the next migration to `ServerDesk/drizzle/`.
   3. Delete the snapshot of the previous migration in `ServerDesk/drizzle/meta/`. Git tracks only `_journal.json` and the newest snapshot, and `tests/repo/tracked-files.mjs` checks this.
   4. Write triggers by hand in the migration, as PL/pgSQL functions with `RAISE EXCEPTION '<literal>'`. Register each new literal in `lib/server/errors/db-codes.ts`.
   5. Run `pnpm db:schema-lock` and commit `drizzle/schema.lock.sql` together with the migration.

   SQL lives only in domain modules under `ServerDesk/lib/server/`, never in `ServerDesk/app/` or `ServerDesk/ui/`. Values go into SQL only through the `sql` tag of the data layer. The tests need PostgreSQL: set `TEST_DATABASE_URL` or start Docker.
6. In the description of the pull request, write the consent sentence from the section [Consent](#consent).

## Project layout

The product is in `ServerDesk/`. Each top-level folder holds one kind of file:

- `agent/`: the Windows agent (C#) and its plugins. `v3` is the agent protocol 3.
- `app/`: the Next.js routes only. These are `layout.tsx`, `page.tsx`, `globals.css`, `remote-desktop/page.tsx` and the `route.ts` files of the API and the downloads.
- `db/`: the Drizzle schema.
- `deploy/`: the Caddy and Azure deployment files.
- `docs/`: the documentation for operators and users, and the agent and API contracts.
- `drizzle/`: the numbered SQL migrations. Do not change a migration after its release.
- `e2e/`: the Playwright smoke tests against a running installation.
- `lib/`: the rules and contracts that run on both sides, the server and the browser. `lib/types.ts` is the type contract of both sides.
- `lib/server/`: the server-only code with the SQL, in one folder for each domain: `agent`, `identity`, `devices`, `automation`, `notifications` and `extensions`. Only the route handlers, `runtime/`, `scripts/`, `instrumentation.ts`, `proxy.ts` and `lib/server/` itself import it. The client can import its types with `import type`.
- `public/`: the static files with public URLs.
- `runtime/`: plain `.mjs` modules that also run outside the Next.js bundle, for example startup, database and storage.
- `scripts/`: the command-line tools, for example selfhost, pipeline, releases and the test runners.
- `tests/`: the regression tests, in the folders `agent/`, `api/`, `fixtures/`, `integration/`, `lib/`, `repo/`, `support/` and `ui/<area>/`. These folders mirror the code. `scripts/test.mjs` runs every `.mjs` file below `tests/`, but not the files in `support/`, `fixtures/` and `integration/`. Thus a new test needs no registration. To run one test, use `node tests/<folder>/<name>.mjs`.
- `ui/`: the browser console, in one folder for each area.

The folders of `ui/` are:

- `base/`: the foundations without a look, for example language, HTTP client, rights and breakpoints.
- `kit/`: the shared building blocks with a look and without a domain, for example `Btn`, `Card`, `Drawer`, `DataTable`, `Tabs` and `Field`.
- `styles/`: the five stylesheets that the console loads one time.
- `shell/`: the console frame, for example the rail, the top bar, the navigation model, the command palette, the help and the job dock.
- `session/`: sign-in, invitation, MFA, step-up, the session gate and the automatic logout.
- `account/`: the page **My account**.
- `settings/`: the settings pages and their models.
- `automation/`: the automation pages, the runbooks, the desired state and the drift.
- `devices/`: the area **Devices**, with one folder for each topic. The topics are `fleet`, `add-device`, `device`, `monitoring`, `hardware`, `inventory`, `protection`, `diagnostics`, `management`, `remote`, `extensions`, `history`, `configuration` and `assistant`.

Put a new file of `tests/` in the first folder that applies:

1. `support/`: a helper that tests import. A helper does not run alone.
2. `integration/`: a test that only `pnpm test:selfhost` or `pnpm test:http` runs.
3. `repo/`: a guard over the repository, or a test of `scripts/`, the CI workflows or the compose files.
4. `agent/`: a test of the Windows agent or its plugins in `agent/`.
5. `api/`: a test that calls the handlers of `app/api/**/route.ts`.
6. `ui/<area>/`: a test of a view or a model in `ui/<area>/`. A test of more than one area goes in `ui/shell/`.
7. `lib/`: all other tests, for example of `lib/`, `lib/server/`, `runtime/`, `db/` and the migrations.

`fixtures/` holds the test data. The folders `agent/`, `api/`, `integration/`, `lib/`, `repo/` and `ui/<area>/` hold only test files and no subfolders. A test gets the root folders from `tests/support/paths.mjs`.

Obey these rules. `ServerDesk/tests/repo/repo-layout.mjs` checks them:

- Put only route files in `app/`. Put a new view or a new client module in the `ui/` folder of its area.
- In `ui/` and `app/`, import project files with the alias, for example `@/ui/kit/kit` or `@/lib/types`. This rule also applies to a file in the same folder. Only `app/layout.tsx` imports `./globals.css`.
- Files in `ui/base/` import only from `ui/base/` and `lib/`. Files in `ui/kit/` import only from `ui/kit/`, `ui/base/` and `lib/`. Type-only imports are not part of this rule.
- Files in `ui/` do not import from `app/`. A `route.ts` file does not import from `ui/`.
- Files in `lib/` (also in `lib/server/`) do not import from `app/` or `ui/`. This rule has no exception.
- Put server-only code in the domain folder of `lib/server/`. Put a model that only the browser console uses in its `ui/` folder. A file in `lib/` outside `lib/server/` must be in use on the server and in the browser.
- Only the route handlers, `runtime/`, `scripts/`, `instrumentation.ts`, `proxy.ts` and `lib/server/` import a file in `lib/server/` as a value. Other files can import its types with `import type`. ESLint also checks this rule.
- Names of files and folders are in lower case with hyphens. Do not use the prefixes `v3-`, `sd-` or `sdx-` in `ui/`. Each file name occurs only one time in `ui/`.
- Put a test in the `tests/` folder of its subject (see the list above), not at the root of `tests/`. Each test file name occurs only one time in `tests/`.

## Language

English is the working language of the project.

- Write code, names, code comments, commit messages, pull requests, issues and documentation in English.
- The portal shows its interface in English and German. Put text for users into the message catalogs (refer to [Translations](#translations)), not into comments.
- German is permitted only in the German catalogs `lib/i18n/messages/de.ts` and `de-server.ts`, and in tests that check German output. In documentation, German is permitted only in code blocks and as inline code for a stored literal value, for example an audit action.
- Do not change a released migration, also not its comments. The migration runner compares the checksum of each applied file.

## Translations

The portal is available in English and German. Users select the language in the account menu or in the command palette.

- The default language is English. `defaultLocale` in `lib/i18n/locale.ts` is the only place that sets the default.
- The browser keeps the choice in the cookie `serverdesk-locale` (`en` or `de`) for one year. `lib/i18n/locale.ts` reads and writes it.
- `app/layout.tsx` reads the cookie on the server and sets `<html lang>`. Thus the first paint has the correct language. Without a cookie, `negotiateLocale` takes the supported language with the highest `q` from the `Accept-Language` header of the browser. The server writes no cookie. `ui/base/locale.tsx` is the only module that changes the language in the browser.
- In components, use `useT()` for text and `useLocale()` for the current language.
- These hooks operate only in the browser. Thus a file that calls `useT()`, `useStableT()` or `useLocale()` starts with the `'use client'` directive. `tests/repo/i18n.mjs` checks this rule.
- The texts are in two catalogs: `lib/i18n/messages/en.ts` (the source of the keys) and `lib/i18n/messages/de.ts`. Keys are flat, with dots, and start with the area, for example `shell.signOut`.
- To add a text, add the key to `en.ts` first, then to `de.ts`. `tsc` fails if a key is missing or extra in `de.ts`. Write full sentences. Do not join parts of sentences in code.
- Placeholders have the form `{name}`. For plurals, use an object `{one, other}` with `{count}`, and give `count` as a parameter.
- Format dates, times and numbers only with `lib/i18n/format.ts`. Use `formatNumber`, `formatDate`, `formatTime` and `formatDateTime`. They give `Intl` options to the browser without changes. Do not use a fixed locale such as `'de-DE'` for text that the portal shows.
- Use `formatPercent` for percentages, `formatBytes` and `formatRate` for sizes, `formatDuration` for durations ("850 ms", "2 h 5 min") and `formatTemperature` for temperatures ("41 °C"). Do not write a unit next to a number in code. Show a missing value as `EMPTY_VALUE` ("—"). To lower the case of search text, use `toLocaleLowerCase(locale)` with the console language.
- Use the words of the [Glossary](#glossary) in both catalogs. For example, "permission" and `Berechtigung` name what a role gives, and "account" and `Konto` name a portal identity. The glossary also gives the rules for punctuation, plurals and reset labels. `tests/repo/copy-terminology.mjs` checks the rules.
- A function without hooks that returns text takes `locale` as its last parameter. The default is `defaultLocale`, so a function without `locale` returns English.
- Server messages are catalog texts too. An `HttpError` takes a message key that starts with `apiError.`, and parameters, for example `new HttpError('apiError.release.sameVersion',{name})`. Do not give a text to `HttpError`. `lib/errors/api-error-keys.ts` gives each key its error code, and the code gives the HTTP status.
- The server texts are in `lib/i18n/messages/en-server.ts` and `de-server.ts`. `en.ts` and `de.ts` include them.
- The error answer of the API has the fields `code`, `messageKey`, `params` and `error`. `error` is the English text. The client shows `apiErrorText(locale, body)` from `ui/base/api-error-text.ts`. This function uses the text of the key. If the client cannot resolve the key (unknown key, missing param), it uses the default key of the code, then `error`. An answer without a key (the text form of `HttpError`, which only test doubles use) shows `error` as sent.
- A display text in a successful answer is a `serverMessage.*` key with its parameters (`lib/server-messages.ts`). A fixed status text that the server stores, for example in `jobs.result`, is the `serverMessage.*` key itself. The client shows such a value with `storedMessageText`. Old rows with German text stay as they are.
- Branch on the error code, never on message text. To open the identity confirmation, use `opensMfaPrompt(code)` from `lib/errors/codes.ts` with the code of the failed request.
- The guard in `tests/repo/i18n.mjs` walks all files in `app/` and `ui/`. The constant `translatedFiles` adds the files in `lib/`. The test fails if such a file contains German UI text, an umlaut or a fixed-locale formatting call.

### Glossary

Use one word for each idea in all four catalogs (`en.ts`, `de.ts`, `en-server.ts` and `de-server.ts`). `tests/repo/copy-terminology.mjs` checks these rules. Its allowlists hold only keys where a word is correct in its context, each group with its reason.

| Idea | English | German | Never in the UI |
|---|---|---|---|
| Portal identity | account | `Konto` | "user" or `Benutzer` for a portal identity. Permitted: "user group" (`Benutzergruppe`), the sign-in field "Username" (`Benutzername`), and Windows users on a device |
| What a role gives | permission | `Berechtigung` | "right(s)" or `Recht(e)` in this meaning |
| The area | access | `Zugriff` | — |
| Object with a life cycle (account, user group, customer, agent release) | Deactivate, Activate; state Deactivated, Active | `Deaktivieren`, `Aktivieren`; `Deaktiviert`, `Aktiv` | "Turn off" for these objects |
| Function (channel, rule, sign-in method, check, firewall rule, scheduled task, Remote Desktop, inheritance) | Turn on, Turn off; state On, Off | `Einschalten`, `Ausschalten`; `Ein`, `Aus` | `An` as a state, `aktivieren` or `deaktivieren` for a function, "Enable" or "Disable" |
| Destroy an object that exists only in the portal | Delete | `Löschen` | — |
| Take something out of a relation (member, tag, assignment, device, stored key) | Remove | `Entfernen` | — |
| What a rule reports on a device | issue | `Hinweis` | "problem" or "note" in this meaning |
| The record that a user can acknowledge and mute | alarm | `Alarm` | — |
| Create action | Create, created | `erstellen`, `erstellt` | `anlegen`, `angelegt`, `erzeugen` or `erzeugt` for a create action. "Generate" a signing secret and "rules produce issues" stay |
| Work item of the agent | job | `Auftrag` | "task" or `Aufgabe` for a job. Windows scheduled tasks keep "task" (`Aufgabe`) |
| Agent mode | Read-only, Management; long form Read-only mode, Management mode | `Nur lesen`, `Verwaltung`; `Nur-Lesen-Modus`, `Verwaltungsmodus` | `ReadOnly` and `Nur-Lese-Modus`. The labels come only from `agentModeLabel` |
| Password | password | `Passwort` | `Kennwort` |
| Automation area | Automation | `Automation` (compounds: `Automations…`, for example `Automationsvorlage`) | `Automatisierung` |
| Device without a group | Ungrouped | `Ohne Gruppe` | "No group" for this |
| Add-on of the agent | extension | `Erweiterung` | "plugin" or "server role" as the name of the add-on |
| Starter of the runbook editor | Start from | `Ausgangspunkt` | "Template" for the starter |
| Time ranges | 30 min, 1 h, 6 h, 24 h | `30 Min`, `1 Std`, `6 Std`, `24 Std` | "30 minutes" or `30 Minuten`. One label set (`device.summary.range*`) |
| Reset a search | Clear search | `Suche löschen` | — |
| Reset filters | Reset filters | `Filter zurücksetzen` | "Reset filter" or "Clear filter" |
| Reset one status switch | Show all | `Alle anzeigen` | — |
| Show the devices | Show devices | `Geräte anzeigen` | `Geräte zeigen` |
| Sample devices, reason for a block | Not available for sample devices. | `Bei Beispielgeräten nicht möglich.` | A second key with the same text. `kit.unavailable.demo` is the one key |

Obey these rules for punctuation, plurals and reset labels:

- **Punctuation.** Do not put a space before "…" in the two languages, and do not use "...". A menu entry or button that opens a dialog or drawer ends with "…".
- **Periods.** These texts end with a period: toasts, reasons for a block, descriptions, field errors, notices and help tips. These texts end without a period: titles, labels, column heads, tab labels, button labels, menu entries and titles of empty states. If the title of an empty state holds two sentences, split it into a title key and a description key.
- **One key for each generic text.** "Cancel", "Close", "Save", "No changes.", "Saving…" and "Try again" are only in `common.*` and `kit.*`. Do not add a second key with the same text.
- **Plurals.** A value with `{count}` whose words agree with the count is a plural object `{one, other}` in the two languages, for example `{count} läuft` and `{count} laufen`. Only symbols and fixed forms stay strings, for example "+{count}", "{count} / 500" and "{name} ({count})". The guard lists them by key.
- **Reset labels.** A reset in an empty state or a toolbar tells exactly what it resets. Use "Clear search" (`Suche löschen`) for a search and "Reset filters" (`Filter zurücksetzen`) for one or more filters. Use "Show all" (`Alle anzeigen`) for one status switch. An action that goes back to the default view and names its object stays, for example "Show all certificates".

## Writing documentation

Write all documentation in English after ASD-STE100 (Simplified Technical English, Issue 9). These rules apply to all documents. `ServerDesk/tests/repo/docs-ste100.mjs` checks the rules that a script can measure. It checks every Markdown file of the repository except license texts. The reviewers check the vocabulary, the active voice and the imperative.

- Write a maximum of 20 words in a sentence of a numbered step. Other sentences have a maximum of 25 words.
- Write a maximum of 6 sentences in a paragraph. For more information, use a list or a new paragraph.
- In a procedure, use the imperative. Write only one instruction in each sentence.
- Use the active voice. Tell the reader who or what does the action.
- Do not use contractions, for example `don't` or `it's`.
- Do not use phrasal verbs, for example "set up" or "turn off". Use one verb, for example "configure" or "disable".
- Write "for example". Do not write `e.g.`.
- The portal shows English text by default. Quote the English text from `lib/i18n/messages/en.ts` or `en-server.ts` without changes, so that the reader can find it in the portal. Write labels in bold, for example **Add device**. Write messages as inline code, for example `The device was not found.`.
- Do not write German outside code blocks. Some values that the code stores are German, for example audit actions. Quote such a value as inline code without changes, and tell the reader that it is the stored value.
- Keep technical names without changes. Examples are Agent, Heartbeat, Runbook, Drift, Passkey, ReadOnly, Management, file names, API paths and error codes.
- Do not change the text of code blocks and inline code when you edit the text around them.

The test uses these counting rules. A sentence ends at `.`, `!`, `?` or `:` before a space or the end of the line. Inline code, bold text and a bare URL count as one word each, and a link counts as its text. The test does not count headings, tables, code blocks and HTML comments. A list item with its indented lines is one unit. Lines of text up to the next blank line, list or heading are one paragraph.

## Contribution terms

A "contribution" is all code, documentation and other work that you submit for inclusion in ServerDesk. You can submit it through a pull request or in a different way.

1. **Your copyright.** You keep the copyright in your contribution.
2. **One license.** You submit your contribution under the license of the project, the AGPL-3.0 ([`LICENSE`](LICENSE)).
3. **No other rights.** The project owner gets no other rights to your contribution. There is no grant of rights, no right to license the contribution to others and no extra patent license. Section 11 of the AGPL-3.0 already covers patents.
4. **Your confirmation.** You have the right to submit your contribution. You mark third-party code in your contribution with its origin and its license.
5. **No obligation to accept.** The project does not have to accept your contribution.

### Consent

To agree, put exactly this sentence in the description of your pull request:

```
I submit this contribution under the AGPL-3.0 license of this project.
```

We do not merge a pull request without this sentence.
