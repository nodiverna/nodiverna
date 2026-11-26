# Dashboard

The **Dashboard** is the start page of the console. It shows the state of the devices that you can see, and it shows what needs your attention first. You select the widgets, their order and their sizes.

## Open the Dashboard

- The portal opens the Dashboard after you sign in, and when you open Nodiverna without a link.
- The first item of the rail opens it. On a screen that is 900 pixels wide or less, it is the first item of the bottom bar.
- The keys `G` then `H` open it. The command palette (Ctrl+K or ⌘K) has the page **Dashboard**.
- The link of the page is `#dashboard`.

## Status line

The line at the top answers one question: is everything running? It shows the first state of this list that applies:

| State | Text | Tone |
|---|---|---|
| At least one open alarm has the level critical | "N open alarms need your attention" | Danger |
| At least one alarm is open | "N open alarms need your attention" | Warning |
| At least one device is offline | "N devices are offline" | Warning |
| No alarm is open and no device is offline | "Everything is running" | Success |

The line also shows how many devices are online, for example "10 of 12 devices online". The dot next to this text pulses slowly while at least one device is online. A device that never connected, or that is in maintenance, is not online and not offline. Removed devices are not counted.

## Widgets

A widget starts with one number. A larger widget also shows a list, a bar with the parts of the number, or a chart. A row of a list opens the place where you can act. Each widget counts only the devices that you can see.

### Monitoring

| Widget | Number | List or chart |
|---|---|---|
| **Open alarms** | The open alarms of your devices, with the count for each level | Critical alarms first, then the oldest alarms. A row opens **Monitoring** of the device |
| **Alarms in the last 7 days** | The alarms that opened in the last 7 days | A heatmap, see below |
| **Alarms per day** | The alarms that opened today | One bar for each of the last 7 days |
| **Device health** | The devices with a warning alarm or a critical alarm | The devices with the worst health first, each with its first alarm |

### Devices

| Widget | Number | List or chart |
|---|---|---|
| **Offline devices** | The devices that are offline | The device that is offline for the longest time comes first |
| **Device status** | The devices that are online | A bar with the online, offline, maintenance and waiting devices |
| **Pinned devices** | The devices that you pinned | Your pinned devices with their connection state |
| **Customers** | The customers that you can see | Each customer with its devices, its open alarms and its offline devices |
| **Highest load** | The online devices with a CPU load or a RAM load of 90 % or more | The online devices with the highest load first |
| **Disk space** | The drives that are 90 % full or more | The fullest drives first. A row opens **Management** › **Disks** of the device |

The **Customers** widget is available only when you can see two customers or more.

### Updates and lifecycle

| Widget | Number | List or chart |
|---|---|---|
| **Updates due** | The pending Windows updates of all devices | The devices with the most pending updates. A label shows when a device needs a restart |
| **Restart required** | The devices that wait for a restart | The devices with the reason for the restart |
| **Operating system support** | The devices whose support ended or ends soon | The devices whose support ended come first |
| **Agent versions** | The devices that do not run the newest reported agent version | The reported versions with the number of devices |

### Security

| Widget | Number | List or chart |
|---|---|---|
| **Microsoft Defender** | The devices with an active threat, with protection off, or with a scan that is too old | Those devices, the devices with a threat first |
| **Drive encryption** | The devices whose system drive is not encrypted, or whose BitLocker protection is suspended | Those devices with their status |
| **Certificates** | The certificates that expired or that expire in 30 days or less | Expired certificates first, then the certificates that expire soonest |
| **New autostart entries** | The new autostart entries of all devices | Suspicious entries first, then the newest entries |

### Hardware

| Widget | Number | List or chart |
|---|---|---|
| **Disk health** | The devices with a disk in an error state or a warning state | Those devices with the status of their worst disk |
| **Crashes** | The crashes of the last 30 days | The devices with the most crashes first |

### Activity

| Widget | Number | List or chart |
|---|---|---|
| **Recent jobs** | The jobs that run or wait | Running and waiting jobs first, then the latest results |
| **Failed jobs** | The jobs that failed in the last 24 hours | The newest failed jobs first |
| **Runbook runs** | The runbook runs that run or wait | Running and waiting runs first, then the latest runs |
| **Recent activity** | The audit entries of the last 24 hours | The newest audit entries with the account and the target |

The **Recent activity** widget is available for an Owner. It is also available for an account that can read the security events of a device.

An empty widget shows a small illustration, one sentence and one action, for example **Show alert rules**.

### Heatmap

The heatmap has one row for each of the last 7 days and one column for each hour. A cell shows how many alarms opened in that hour. A darker cell has more alarms. The line below the heatmap names the hour with the most alarms. Point at a cell to read its day, its hour and its count.

The days and hours follow the time zone of your browser. An alarm counts at the time when it opened, also when it is closed now. The heatmap counts only alarms of devices that you can see now. It loads again when you refresh the console.

## Widget sizes

The Dashboard is a grid with four columns. A window that is less wide shows two columns or one column. With one column, each widget is as high as its content. A widget is 1 to 4 columns wide and 1 to 3 rows high. The heatmap is 2 columns wide and 2 rows high, or larger.

The size of a widget sets what the widget shows:

| Size | Content |
|---|---|
| 1 column, 1 row | The number and one line of text, or the bar with the parts |
| 2 columns or more, 1 row | The number, and the first two rows of the list next to it |
| 2 rows | The number and four rows of the list |
| 3 rows | The number and eight rows of the list |
| 3 columns or more, 2 rows or more | The number on the left, and a longer list on the right |

When a list has more entries than rows, the last line shows how many entries are not shown.

## Customize the Dashboard

1. Select **Customize** in the page header. The page changes to the edit mode.
2. Change the widgets as the sections below describe.
3. Select **Save**.

The page shows your changes while you edit. **Cancel** discards them. The layout is stored on the server for your account, so it follows you to each browser. A layout has no audit entry and no MFA confirmation, because it is a personal display setting.

Sample devices fill the widgets too, but you cannot change the layout while they show.

### Add and remove a widget

- Select **Add widget…** to open the list of all widgets. Select **Add** in the row of a widget. The new widget goes to the end of the Dashboard.
- Select the **Remove** button of a widget to remove it. The list of all widgets still contains this widget, and you can add it again.

### Move a widget

- With a pointer: drag the widget by its move handle. With a mouse, you can also drag the head of the widget. Drop the widget on the place of a different widget.
- With the keyboard: set the focus on the move handle. Press Arrow Left or Arrow Up to move the widget one place to the front. Press Arrow Right or Arrow Down to move it one place to the back. Home moves it to the first place, and End moves it to the last place.
- Without a drag: open **Actions** of the widget and select **Move earlier** or **Move later**.

Press Escape while you drag to put the widget back.

### Change the size of a widget

- With a pointer: drag the handle in the bottom corner of the widget.
- With the keyboard: set the focus on that handle. Arrow Right and Arrow Left change the width. Arrow Down and Arrow Up change the height.
- Without a drag: open **Actions** of the widget and select **Wider**, **Narrower**, **Taller** or **Shorter**.

An entry that cannot change the size shows the reason.

### Go back to the default layout

In the edit mode, select **More actions** › **Reset to default**, then select **Save**. After that, your account follows the default layout again, also when the Owner changes it later.

## Default layout

Accounts without their own layout see the default layout. Only an Owner can change it:

1. Open the Dashboard.
2. Select **More actions** › **Edit default layout**.
3. Add, remove, move and size the widgets.
4. Select **Save**.

**More actions** › **Restore original layout** brings back the layout that Nodiverna ships with. The change of the default layout needs no MFA confirmation, because a widget layout cannot run code or open access. The audit log records it:

| Audit action | Meaning |
|---|---|
| `dashboard.default.set` | The default layout changed. The target is `layout` |
| `dashboard.default.remove` | The default layout went back to the original layout. The target is `layout` |

## Start page

**My account** › **Preferences** › **Start page** selects the page that opens after you sign in:

- **Dashboard** is the default.
- **All devices** opens the device list, as before the Dashboard existed.
- **Alarms** opens **Monitoring** of all devices.

The browser keeps this choice. A link to a page always opens that page. The command palette has an action for each start page.

## Motion

The numbers of the widgets count up when the page shows for the first time, and when a number changes. The widgets move to their new places when the layout changes. If your operating system asks for reduced motion, the numbers show at once, the dot does not pulse and the widgets do not move.

## API

| Request | Who | Effect |
|---|---|---|
| `GET /api/dashboard` | Each signed-in account | The alarm counts for each hour of the last 192 hours, for the devices that the account can see |
| `PUT /api/account/dashboard` | Each signed-in account | Stores the layout of the account. The body is `{"layout": [...]}`, or `{"layout": null}` to follow the default layout |
| `PUT /api/dashboard/default` | Owner | Stores the default layout. The body is `{"layout": [...]}`, or `{"layout": null}` for the original layout |

A layout is a list of the widgets on the Dashboard, in the order of the page. Each entry has the ID, the width in columns and the height in rows: `{"id": "alarms", "w": 2, "h": 2}`. A widget that is not in the list is not on the Dashboard. An empty list is a Dashboard without widgets.

The list can contain each widget one time. The width must be 1 to 4 and the height must be 1 to 3. For `alarm-week`, the width and the height must be 2 or more. The widget IDs are:

- Monitoring: `alarms`, `alarm-week`, `alarm-trend`, `health`
- Devices: `offline`, `status`, `pinned`, `customers`, `load`, `disk-space`
- Updates and lifecycle: `updates`, `restart`, `os-support`, `agents`
- Security: `defender`, `encryption`, `certificates`, `autostart`
- Hardware: `disk-health`, `crashes`
- Activity: `jobs`, `failed-jobs`, `runbooks`, `activity`

`GET /api/console` sends the layout of the account and the default layout as `preferences.dashboard`. All other data of the widgets comes from `GET /api/console`, which contains only the devices and the data that the account can see.

## Storage

The column `account_preferences.dashboard_layout` holds the layout of an account as JSON. It is empty while the account follows the default layout. The table `dashboard_settings` holds the default layout in one row. It has no row while the original layout applies. Migration `0045_dashboard.sql` adds both.

The stored JSON has the form `{"version": 2, "widgets": [...]}` with the list that the API uses.

### Layouts of the first Dashboard

The first Dashboard had five tiles. A stored layout was a list with one entry for each tile: `{"id": "alarms", "shown": true}`. Migration `0046_dashboard_widgets.sql` changes these stored layouts to the new form:

- The tiles that were shown stay on the Dashboard in their order. Each tile gets its default size.
- A tile that was hidden is not on the Dashboard. You can add it again from the list of all widgets.
- The new widgets are not added to a stored layout. An account that follows the default layout sees the new original layout.

The migration changes no other data. The portal also reads a layout of the first form correctly when the migration did not change it.
