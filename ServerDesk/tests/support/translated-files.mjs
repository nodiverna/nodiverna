// The lib/ files with translated UI text that the i18n source guards scan next to every file
// under app/ and components/: the translated UI helpers (since the lib/server/ move, the UI-only
// ones are models in ui/), the error contract (lib/errors/, lib/server/errors/ and
// ui/base/api-error-text.ts). tests/repo/i18n.mjs (German literals, fixed-locale formatting) and tests/repo/copy-terminology.mjs
// (hand-built units) share the list.
import {readdirSync} from 'node:fs';

export const translatedFiles=[
 'ui/devices/fleet/fleet-tags.ts','ui/devices/fleet/fleet-csv.ts','ui/devices/fleet/fleet-columns.ts','lib/job-display.ts','ui/base/ui-device.ts','ui/devices/management/service-view.ts','ui/devices/management/network-panel.ts','ui/devices/management/update-view.ts','ui/devices/management/storage-size.ts','lib/agent-update-state.ts','ui/devices/diagnostics/diagnosis-client.ts','ui/devices/inventory/health-signals.ts','ui/devices/fleet/fleet-filters.ts','ui/devices/inventory/software-csv.ts','ui/devices/management/feature-catalog.ts','ui/automation/desired-state-ui.ts','ui/devices/fleet/fleet-agent-update-state.ts','ui/base/agent-reasons.ts',
 // Server messages: the error contract and the server message helpers.
 ...['lib/errors','lib/server/errors'].flatMap(dir=>readdirSync(dir).filter(name=>/.ts$/.test(name)).map(name=>`${dir}/${name}`)),'ui/base/api-error-text.ts','lib/server-messages.ts',
];
