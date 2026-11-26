# Branding

An Owner can give the portal the look of the organization. The Owner uploads a portal logo, a browser tab icon and, while **Multiple customers** is on, a logo for each customer. The Owner also selects a background for the sign-in page and a background for the console, and applies a color scheme from the logo. The product name "Nodiverna" stays in the page title, on the sign-in card, in the accessible names and in the email sender. This is no white-label function.

## Who changes branding, and where

Only a global Owner opens the page **Settings** › **Branding** (`#settings/branding`). The page is in the group **Organization**, after **Customers**. Other accounts do not see the page. A direct link shows the page header and a notice that the permission is missing.

The page starts with the card **Preview**. Then the cards follow in the sequence of what they change:

- **Logo and icon**: three rows, for the logo of the light appearance, the logo of the dark appearance and the browser tab icon. Each row shows the image on a light or a dark surface, at its top bar size. An empty row shows the image that the portal uses in its place.
- **Colors**: colors from the portal logo and a sample of the scheme. Refer to [Color scheme](#color-scheme).
- **Sign-in page** and **Console**: the background of the area. Refer to [Backgrounds](#backgrounds).
- **Customer logos**: only while **Multiple customers** is on. The card contains a table with each customer other than the default customer, also deactivated customers.

An upload replaces the image of its slot. Before a removal, the page asks for a confirmation and tells you which image shows in its place.

### Preview

The card **Preview** shows one browser window in miniature. The tab of the window shows the browser tab icon and the page title. Below the tab, the window shows the sign-in page or the console with the logo, the colors and the background of the page.

- **Shown page** selects **Sign-in page** or **Console**. A change of a background shows the page of that background automatically.
- **Appearance** selects **Light** or **Dark**. The preview starts with the appearance of the console.

The preview uses the brand colors (the applied color scheme, else Aurora), not the color scheme of the Owner account. When you select a color in the card **Colors**, the preview shows it before you apply it. Then the note "These colors are not applied yet." shows below the window. After each change on the page, the preview shows the new state at once.

In a page area of 820 px or more, the preview is a column on the right side of the cards. It stays in view while the cards move. In a smaller area, the preview is above the cards.

### State of a setting

Each setting shows a tag: **Default** or **Custom**.

| Setting | **Custom** when |
|---|---|
| A row of **Logo and icon** | The slot has an uploaded image |
| **Colors** | A color scheme is applied |
| **Sign-in page**, **Console** | The background is not **None** |

To go back to the default, remove the image of a row, use **Reset to default colors…**, or select the background **None**. A row without an image tells you what shows in its place: the logo of the other appearance, the Nodiverna logo or the Nodiverna icon. A row with an image shows the format, the pixel size and the file size.

Each row and each background card shows the formats and the limits of its upload. When an upload to a portal slot fails, the row or the card of that slot shows the cause and the correction. The message stays until the next upload or removal of a portal image starts. A customer logo that fails shows a short message at the edge of the window.

## Slots and fallback order

The portal has the slots `light`, `dark`, `icon`, `signin` and `console`. A customer has the slots `light` and `dark`. The default customer has no own logo, because the portal logo stands for it. The slots `signin` and `console` hold the uploaded backgrounds (refer to [Backgrounds](#backgrounds)).

The light and the dark variant fall back to each other. If only one variant exists, it shows in both appearances. The stylesheet picks the variant from the appearance of the console (`data-theme`, and `prefers-color-scheme` for **System**). No script is necessary.

The top bar uses the first of these logos that exists (`ui/shell/brand-logo-model.ts`):

1. While **Multiple customers** is on: the logo of the customer that the console shows. This is the customer scope, its **Ungrouped** scope, a group of the customer or a device of the customer.
2. The logo of the one customer that the account sees, if this customer is not the default customer.
3. The portal logo.
4. The Nodiverna mark.

The sign-in, invitation, MFA and session screens show the portal logo with the product name beside it. Without a portal logo, or when the request fails, they show the Nodiverna mark.

## Customer avatars

Each customer folder in the navigator tree shows an avatar of 20 × 20 pixels. If the customer has a logo, and the width of each variant is 0.5 to 2 times its height, the avatar shows the logo. The avatar uses the light or the dark variant of the appearance. A wide logo does not fit a square, so the avatar then shows the initials of the customer.

The initials are the first letter or digit of the first two words of the customer name, in upper case. For example, `Ölwerke Nord` gets `ÖN` and `Contoso` gets `C`. A name without letters and digits gets `#`. The initials use the accent color of the color scheme.

## Formats and limits

The portal accepts PNG, WebP, JPEG and SVG. It finds the format from the content of the file, never from the file name or the `Content-Type` header. It reads the pixel size from the file headers and does not decode the pixels.

| Slot | File size | Pixel size | Proportions |
|---|---|---|---|
| `light`, `dark` | At most 2 MiB | Raster images: 16 to 4096 px for each side | Width divided by height from 0.5 to 8, also for SVG |
| `icon` | At most 256 KiB | Raster images: 32 to 1024 px for each side | Square |
| `signin`, `console` | At most 8 MiB | Raster images: 320 to 7680 px for each side. SVG has no pixel limit | No limit |

The portal refuses animated images: a PNG with an `acTL` chunk before the image data, and a WebP with the animation flag or an `ANIM` chunk. A logo that moves all the time ignores the setting for reduced motion.

The portal stores PNG, WebP and JPEG files without changes. Metadata in the file, for example EXIF or XMP data with a GPS position, stays in the file. The portal logos and the icon are public. Remove the metadata before you upload a file.

## SVG cleaning

The portal cleans each SVG file at upload and keeps only the cleaned file (`lib/server/branding-image.ts`). The cleaner reads the file with a strict XML parser and writes a new document.

The cleaner refuses the file in these cases:

- The file has a `<!DOCTYPE` or an `<!ENTITY`.
- The XML is not well-formed: a tag is not closed, tags do not match, an attribute has a bad syntax or occurs two times.
- The root element is not `svg`.
- The text is not valid UTF-8.

The cleaner keeps only the elements for shapes, text, groups, gradients, patterns, masks, clip paths, styles and some filters. It removes each other element with all its content, for example `script`, `foreignObject`, `image`, `a`, `iframe` and the animation elements. It removes comments and processing instructions.

The cleaner keeps only the presentation and geometry attributes and a small list of other attributes. It removes each `on…` attribute and each other attribute with a namespace prefix. `href` and `xlink:href` stay only on `use`, gradients and patterns, and only as a local `#id`. An attribute value with `javascript:`, `vbscript:`, `data:` or an external `url(` goes away.

A `style` element or attribute with `@import`, `expression(`, an external `url(`, `javascript:`, `<` or a CSS escape goes away completely. A file without a shape, a text or a `use` element after the cleaning gets the error `svgEmpty`.

The size of an SVG file comes from its `viewBox`. Without a `viewBox`, the size comes from numeric `width` and `height` attributes, without a unit or in `px`. The portal rounds the size up.

## Emails

Notification emails show the portal light logo above the heading. The logo shows only when these conditions are true:

- `SITE_ORIGIN` has a value.
- The light logo is a PNG or a JPEG file. Many mail clients do not show WebP or SVG.

The email loads the logo from `{SITE_ORIGIN}/api/branding/portal/light?v=<version>`. Thus the mail client must reach the portal, as for the alarm links. The text part of the email, Teams, Discord and webhooks do not change. The Branding page shows a notice when the light logo is a WebP or an SVG file.

## Browser tab icon

The page links the icon `/api/branding/favicon`. With an uploaded icon, this route sends the icon and the browser checks it again on each load. Without an icon, the route sends a redirect (307) to `/favicon.svg`. After an upload or a removal, the Branding page changes the icon of the open tab at once.

## Backgrounds

The sign-in page and the console each have a background. Each area has its own choice and its own uploaded image. Thus a background can show only on the sign-in page, only in the console, or in both.

The choice of an area is one of these:

- **None**: the area shows its usual surface. This is the default.
- One of six bundled backgrounds: **Mist**, **Dusk**, **Tide**, **Dune**, **Slate** and **Bloom**. They are abstract SVG gradients (`public/backgrounds/<id>.svg`, at most 16 KiB each) without text, images or scripts. Four are mid-to-dark and two are light.
- **Own image**: the uploaded image of the area. The upload uses the checks and limits of [Formats and limits](#formats-and-limits). An upload also selects **Own image**.

The tiles of a card are a radio group. The arrow keys move the focus. Enter or Space selects the tile, because each selection saves at once. **Own image** without an upload opens the file picker. When you select a bundled background, the uploaded image stays stored. When you remove the uploaded image while **Own image** is the choice, the area shows **None**.

**Sign-in page.** The sign-in, invitation, MFA and session screens show the background as a full-screen image behind a light scrim. The image is not blurred. While it shows, the card is the solid panel surface, so each text on the card keeps a contrast of 4.5:1 for each image. Without a background, or when the image cannot load, the usual surface stays. The image is off for forced colors.

**Console.** The console shows the background behind the whole console, as one continuous picture. It is like the wallpaper behind the windows of a desktop. The image is behind the top bar, the side bar, the navigator, the workspace and the job dock, at each width.

The image is strongly blurred. Each mode has its own filter (`backdropFilters` in `lib/backdrop.ts`, declared one time in `ui/shell/console-backdrop.css`):

- Light mode: `blur(48px) saturate(1.4)`.
- Dark mode: `blur(48px) saturate(1.2) brightness(.9)`.

The dark filter applies for the dark theme, and for **System** when the operating system uses the dark appearance. The image is fixed to the window and does not move with the page. It receives no pointer events. It fades in one time.

**Surfaces.** Each region puts a scrim of the background color (`--sd-bg`) on the image. Then the region puts its surface on the scrim:

| Region | Surface on the scrim |
|---|---|
| Top bar, side bar, job dock (the bars) | The glass surface. At 900 px or less, the bottom bar has the strong glass surface |
| Navigator, also as the overlay at 900 px or less | The strong glass surface |
| Workspace | No surface. Cards, tables, notices, drawers and dialogs keep their solid panel surface. Menus, the command palette and the select list keep the strong glass surface |

Thus the image shows through the bars, and around and between the content surfaces. Text and tables stay on their own surfaces. The bars and the docked navigator use no backdrop blur while the image shows, because the image is blurred already.

**Secondary text on the background.** In light mode, secondary text directly on the bars, the navigator and the workspace canvas uses a darker tone while the background shows. Examples are the breadcrumb, the page subtitle, the tab labels and the navigator headings. The tone is `--sd-ink` at 40 % over `--sd-muted` (`--sdx-muted-backdrop` in `ui/shell/console-backdrop.css`). It has a contrast of about 7.1:1 on `--sd-bg`. In dark mode, the tone is `--sd-muted`.

Cards, tables, KPI tiles, the health line and disclosures keep the normal `--sd-muted`, so content looks the same with and without a background. Menus, drawers and dialogs also keep the normal tone.

**Dimming from the image.** The scrim of each region and mode is the smallest percentage that keeps the text of each surface at 4.5:1:

- Bars, navigator and the workspace canvas: `--sd-ink` and the secondary tone of the background.
- Menus, the command palette and the select list on the workspace: `--sd-ink` and `--sd-muted`.
- Light mode, the tab bar on the workspace: the active tab label (`--sd-accent-strong`).

The check uses each surface of the region, each color scheme of the mode, and the darkest and the brightest color of the blurred image. `backdropScrims` in `lib/backdrop.ts` calculates the six values. The console writes them on the frame as `--sdx-scrim-<region>-<mode>`.

The darkest and the brightest color come from a measurement (`measureBackdrop` in `lib/backdrop.ts`). The measurement blurs the whole image and applies the filter of each mode. Then it keeps the lowest and the highest value of each color channel. Its blur is weaker than the console blur, so the range is never too narrow. A transparent pixel counts as black and as white.

- **Bundled backgrounds**: the values are in `brandingBackgrounds` (`lib/branding.ts`). `node scripts/measure-backgrounds.mjs` renders the six SVG files at 1920 × 1080 px in Chromium and prints the values.
- **Own image**: the browser of the Owner measures the upload. The server does not decode the pixels. Refer to [Measurement of an uploaded console background](#measurement-of-an-uploaded-console-background).
- **No measurement**: the console uses the fallback scrims. They keep 4.5:1 over a black and a white pixel, so they are safe for each image. The fallback scrims are 32 % (bars), 0 % (navigator) and 82 % (workspace) in light mode, and 64 %, 5 % and 88 % in dark mode.

In light mode, a light image shows fully (0 %). A dark image keeps a workspace scrim of about 80 %, because dark text needs a light surface. `tests/ui/styles/theme-backdrop.mjs` checks each mode, scheme, region and surface.

**Accessibility settings.** The background is off when the operating system reduces transparency (`prefers-reduced-transparency`) and for forced colors. Then the console looks as it does without a background, and the setting can change while the console is open. Some browsers do not support `prefers-reduced-transparency` yet. They show the background.

### Measurement of an uploaded console background

The Branding page measures an uploaded console background in two cases:

1. After an upload to the console slot.
2. When the page opens and the stored upload has no measurement. This applies to uploads from before the measurement existed.

The page loads the image from its URL and draws it on a canvas, at most 320 px on the long side. Then it runs `measureBackdrop` and sends the result with the action `measureBackground`. A newer upload or a closed page stops a running measurement, and the page does not send its result.

While the measurement runs, the card **Console** shows "Fitting this image to the console…". When the image cannot load or the request fails, the card shows a warning with **Try again**. Until a measurement is stored, the console uses the fallback scrims.

**Your own console background.** Each account can turn the console background off for itself in **My account** › **Preferences** (**Console background**), or with the command palette action **Turn off console background**. The portal stores this choice for the account (`account_preferences`), so it applies in each browser. The switch is blocked while the portal has no console background. When the Owner turned the background off for the Owner account, the card **Console** shows a notice.

## Color scheme

The Owner can apply a color scheme from the portal logo. The scheme becomes the color scheme **Brand colors** in the list of color schemes.

**Colors from the logo.** The browser of the Owner reads the colors of the logo. The server does not decode the pixels. The page loads the light logo (else the dark logo) and draws it at a size of at most 96 × 96 px. Then it counts the colors (`ui/settings/brand-colors-model.ts`).

The count ignores transparent pixels, gray pixels and pixels that are almost black or almost white. It gives up to three colors, the most frequent first. Each color must have at least 2 % of the visible pixels. Its hue must be at least 30° from the colors before it. A logo in black, white or gray gives no color.

**Derivation.** You select the main color (the lead color of the scheme). The first other color becomes the second color (with one color, both are the same). `lib/brand-scheme.ts` makes the scheme with the roles of the other schemes:

- Light mode: the lead color is the accent and the start of the gradient. The second color tints the background and the glow and ends the gradient. The panel stays white.
- Dark mode: the second color leads. The lead color tints the background and the panel.

**Contrast check.** The scheme must pass each contrast pair of the theme tokens in both modes (`tests/ui/styles/theme-tokens.mjs`). The text on the accent must have 4.5:1 on both ends of the gradient. To get this contrast, the module changes the scheme in 1 % steps:

1. It mixes the lead color with black (light mode) or with white (dark mode), up to 60 %.
2. It reduces the tint of the background and the panel down to 0. The tint starts at 6 % (light) or 10 % (dark).
3. It reduces the share of the second color at the end of the gradient from 37 % down to 0.


The text on the accent is white when white has 4.5:1, else dark. The card **Colors** shows the lowest contrast of the buttons, the links and the icons, and it tells you how much the main color changed. A sample frame for each mode shows a button, a link, a selected row and an icon in the new colors. Nothing is saved before **Apply colors**. The server makes the same derivation and check again.

The last line of the card tells you which colors are in use: the default colors (Aurora) or your colors. **Reset to default colors…** removes the applied scheme after a confirmation.

**Default for accounts.** An account without its own choice of a color scheme sees **Brand colors**. An account that selected a scheme keeps it. Without an applied scheme, **Brand colors** looks the same as Aurora, so the lists show only Aurora. With an applied scheme, the lists show **Brand colors (default)** first and then **Aurora**.

**Stylesheet.** Each page links the stylesheet `/api/branding/scheme` in its head. The stylesheet has only `--brand-<mode>-<name>` values in the format `#rrggbb`. The scheme blocks of `app/globals.css` read these values and use the Aurora values when they are missing. Thus the sign-in page and the console show the brand colors at the first paint, without a script. After **Apply colors** or **Reset to default colors…**, the Branding page loads the stylesheet again, so the open page changes at once.

## API

| Route | Access | Answer |
|---|---|---|
| `GET /api/branding` | Public | `{portal:{light,dark,icon}, signinBackground}`. Each image is `null` or `{url, contentType, width, height, size, updatedAt}`. `signinBackground` is `null`, `{kind:'builtin', id, url}` or `{kind:'upload', url, width, height}`. There is no data about the console |
| `GET /api/branding/scheme` | Public | The brand stylesheet (`text/css`), or a comment without a scheme. `Cache-Control: no-cache`, `ETag` (SHA-256 of the body), 304 for a matching `If-None-Match` |
| `GET /api/branding/portal/<slot>` | Public | The image. 304 for a matching `If-None-Match`, 404 for an empty or unknown slot |
| `GET /api/branding/customer/<id>/<slot>` | An account that sees the customer, or a global Owner | The image. 404 for all other accounts, so the answer does not show that the customer exists |
| `GET /api/branding/favicon` | Public | The icon, or 307 to `/favicon.svg` |
| `GET /api/branding/manage` | Global Owners | The portal slots, `multipleCustomers`, the customers with their logos, `backgrounds` (`{signin, console}`, each `{choice, upload}`) and `scheme` (`{primary, secondary}` or `null`). `console` also has `measured` (`true` when the upload has a measurement, `false` without an upload) and `scrim` (the scrims of the choice, or `null` for **None**) |
| `POST /api/branding/manage` | Global Owners, same origin | One action as JSON. Refer to the table below. The answer is the state of `GET /api/branding/manage` |
| `PUT` and `DELETE` on the portal and the customer image routes | Global Owners, same origin | The state of `GET /api/branding/manage` |
| `PUT /api/account/preferences` | Each account, for itself, same origin | `{consoleBackground}`. The body is `{consoleBackground: true or false}` |

`GET /api/console` has `branding.consoleBackground`, `branding.scheme` and `preferences` (`{consoleBackground}` of the account, `true` without a stored value). `consoleBackground` is `null` or the view of `signinBackground` with two more fields. `scrim` has the six percentages (`{light:{bars, navigator, workspace}, dark:{…}}`). `measured` is `false` when the scrims are the fallback.

| Action of `POST /api/branding/manage` | Effect |
|---|---|
| `{action:'setBackground', area:'signin' or 'console', choice}` | Sets the choice of the area: `none`, `upload` or a bundled id. `upload` needs a stored image of the area |
| `{action:'setScheme', primary, secondary}` | Stores the two colors (lower-case `#rrggbb`) after the server derived and checked the scheme |
| `{action:'clearScheme'}` | Removes the scheme. Accounts without their own choice see Aurora again |
| `{action:'measureBackground', version, measure}` | Stores the measurement of the console upload. `version` is the `v` of its URL (16 lower-case hex characters). `measure` is `{light:{low, high}, dark:{low, high}}` with lower-case `#rrggbb` values |

The same choice, the same colors and a clear without a scheme write nothing.

`measureBackground` writes only when the stored console upload has the hash that `version` starts with. The Owner right is part of the same statement. An old version, no upload or the same values write nothing. A `low` channel above its `high` channel, or a value in another format, gives `apiError.request.invalid`. This action writes no audit entry, because the values come from the upload, which has its audit entry, and they change no setting.

The `url` of an image has `?v=` with the first 16 hex characters of its SHA-256 hash. An image answer has these headers: `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` and `ETag`. With the current `v`, the image can stay in the cache for one year (`immutable`).

Without the current `v`, the browser checks the image again (`no-cache`). The customer images are `private`. `proxy.ts` keeps the image policy for these paths. When `If-None-Match` names the stored image, the server reads only the hash from the database and not the image.

A `PUT` sends the file as the raw request body. The route reads at most the limit of the slot. A larger `Content-Length` or body gets 413 before the route reads more. A `PUT` with the bytes of the stored image and a `DELETE` of an empty slot write nothing. A `PUT` with new bytes removes the measurement of the slot in the same statement.

Branding needs no new MFA proof. An image, a background choice or a color scheme cannot run code, open access or make security weaker. The live MFA login session and the Owner right are enough ([portal-sessions.md](portal-sessions.md#which-actions-ask-for-mfa-again)). The console background switch of an account is a personal display setting. It has no audit entry and needs no MFA proof.

| Status | Error key | Cause |
|---|---|---|
| 400 | `apiError.branding.format` | The file is no PNG, WebP, JPEG or SVG, or its header cannot be read |
| 400 | `apiError.branding.animated` | An animated PNG or WebP |
| 413 | `apiError.branding.logoTooLarge` | A logo over 2 MiB |
| 413 | `apiError.branding.iconTooLarge` | An icon over 256 KiB |
| 413 | `apiError.branding.backgroundTooLarge` | A background over 8 MiB |
| 400 | `apiError.branding.backgroundDimensions` | A raster background outside 320 to 7680 px for each side |
| 400 | `apiError.branding.backgroundChoice` | An unknown background, or `upload` without a stored image |
| 400 | `apiError.branding.schemeColor` | A color that is not lower-case `#rrggbb`, or a scheme that does not pass the contrast check |
| 400 | `apiError.request.invalid` | An unknown action or area, or a body that is not correct |
| 400 | `apiError.branding.logoDimensions` | A logo outside the pixel or proportion limits |
| 400 | `apiError.branding.iconDimensions` | An icon that is not square or outside the pixel limits |
| 400 | `apiError.branding.svgInvalid` | An SVG file with a DOCTYPE or ENTITY, not well-formed, with another root or not UTF-8 |
| 400 | `apiError.branding.svgEmpty` | An SVG file with nothing to draw after the cleaning |
| 400 | `apiError.branding.svgSize` | An SVG file without a `viewBox` and without `width` and `height` |
| 400 | `apiError.branding.defaultCustomer` | A logo for the default customer |
| 403 | `apiError.settings.ownerOnly` | The account is no global Owner |
| 404 | `apiError.customer.gone` | The customer does not exist |
| 404 | `apiError.generic.notFound` | An unknown slot, an icon or a background for a customer, or an image that the account cannot see |

## Audit

Each upload, each removal and each change of a choice writes one portal audit entry in the same transaction as the change. The target is the slot (`light`, `dark`, `icon`, `signin` or `console`), the area of a background choice, or `scheme`. The audit log shows the entries in the category **Settings**.

| Action | Entry |
|---|---|
| `branding.portal.set` | A portal image was uploaded |
| `branding.portal.remove` | A portal image was removed |
| `branding.customer.set` | A customer logo was uploaded. The entry has the customer in `customer_id` |
| `branding.customer.remove` | A customer logo was removed. The entry has the customer in `customer_id` |
| `branding.background.set` | The background choice of an area changed. The target is `signin` or `console` |
| `branding.scheme.set` | A color scheme was applied. The target is `scheme` |
| `branding.scheme.remove` | The color scheme was removed. The target is `scheme` |

## Storage

Migration `0042_branding_assets.sql` creates the table `branding_assets`. The images are in PostgreSQL, so the database backup contains them. The public sign-in page needs no access to an object storage.

| Column | Content |
|---|---|
| `customer_id` | `NULL` for the portal, else the customer (foreign key to `customers`) |
| `slot` | `light`, `dark`, `icon`, `signin` or `console` |
| `content_type` | `image/png`, `image/webp`, `image/jpeg` or `image/svg+xml` |
| `data` | The bytes (`bytea`). For SVG, the cleaned file |
| `size`, `width`, `height` | The file size in bytes and the size in pixels |
| `sha256` | The SHA-256 hash of `data` |
| `updated_at`, `updated_by` | The time and the principal of the last upload |
| `measure_light_low`, `measure_light_high`, `measure_dark_low`, `measure_dark_high` | The measurement of the console background upload as lower-case `#rrggbb`, or `NULL` |

CHECK constraints keep the rules in the database. There is no icon and no background for a customer, and no row for the default customer. `size` is equal to the length of `data` and is at least 1 byte: at most 2 MiB for a logo, 256 KiB for the icon and 8 MiB for a background. The width and the height are larger than 0, and `sha256` is 64 lower-case hex characters. A unique index on `(COALESCE(customer_id,''), slot)` allows one row for each owner and slot.

Migration `0047_backdrop_measure.sql` adds the four `measure_*` columns. CHECK constraints keep each value lower-case `#rrggbb`, all four set or all four `NULL`, and set only for the slot `console`. Existing uploads start without a measurement.

Migration `0043_branding_backgrounds.sql` adds the slots `signin` and `console` and two tables. It inserts no rows.

`branding_settings` has one row at most (`id` is 1). Without the row, the portal uses the defaults.

| Column | Content |
|---|---|
| `signin_background`, `console_background` | `none` (the default), `upload` or a bundled id |
| `scheme_primary`, `scheme_secondary` | The two colors of the brand scheme as lower-case `#rrggbb`, or both `NULL` |
| `updated_at`, `updated_by` | The time and the principal of the last change |

`account_preferences` has one row for each account that changed a preference. Without the row, the defaults apply.

| Column | Content |
|---|---|
| `user_id` | The account (foreign key to `local_users`). When the account is deleted, the row is deleted |
| `console_background` | `true` (the default) when the console shows the portal background for the account |
| `updated_at` | The time of the last change |

## Where the code is

- `lib/branding.ts`: the slots, the limits and the views that the server and the console share.
- `lib/server/branding-image.ts`: the format, size, animation and SVG checks.
- `lib/server/branding.ts`: the storage, the views, the writes, the brand stylesheet and the email logo URL.
- `lib/brand-scheme.ts`: the derivation and the contrast check of the brand scheme, and the stylesheet text.
- `lib/backdrop.ts`: the filters of the console background, the measurement, the secondary tone and the scrims. `scripts/measure-backgrounds.mjs`: the measurement of the bundled backgrounds.
- `lib/server/account-preferences.ts` and `app/api/account/preferences/route.ts`: the console background switch of an account.
- `app/api/branding/`: the routes.
- `ui/settings/branding-page.tsx` and `ui/settings/branding-model.ts`: the page and the card **Logo and icon**. `ui/settings/branding-preview.tsx`: the card **Preview**. `ui/settings/branding-state-tag.tsx`: the state tag.
- `ui/settings/brand-scheme-card.tsx` and `ui/settings/brand-colors-model.ts`: the card **Colors**. `ui/settings/branding-backgrounds.tsx`: the cards **Sign-in page** and **Console**.
- `ui/shell/console-backdrop.tsx` and `ui/shell/console-backdrop.css`: the console background.

- `ui/kit/brand-logo.tsx`, `ui/shell/brand-logo-model.ts` and `ui/session/session-card.tsx`: the top bar and the session screens.
- `ui/devices/fleet/customer-avatar.tsx` and `ui/devices/fleet/customer-avatar-model.ts`: the customer avatars of the navigator.
