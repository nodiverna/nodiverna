import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// An exemption always applies to exactly one file and names every rule.
// A rule is never switched off globally or for a whole directory.
// tests/repo/lint-scope.mjs checks that every entry exists, has a reason and is
// still needed. The React Compiler findings are fixed file by file; then the
// entry here goes away.
export const lintExemptions = [
  {
    file: "app/layout.tsx",
    rules: ["@next/next/no-css-tags"],
    reason: "the brand color scheme is a per-portal stylesheet from the own API (/api/branding/scheme); it must be render-blocking in the head for the first paint and cannot be a bundled import.",
  },
  {
    file: "ui/kit/brand-logo.tsx",
    rules: ["@next/next/no-img-element"],
    reason: "user logo from the own API, SVG included; next/image optimization does not apply.",
  },
  {
    file: "ui/settings/branding-page.tsx",
    rules: ["@next/next/no-img-element"],
    reason: "user logo from the own API, SVG included; next/image optimization does not apply.",
  },
  {
    file: "ui/settings/branding-preview.tsx",
    rules: ["@next/next/no-img-element"],
    reason: "user logo, icon and background from the own API or a bundled SVG, SVG included; next/image optimization does not apply.",
  },
  {
    file: "ui/settings/branding-backgrounds.tsx",
    rules: ["@next/next/no-img-element"],
    reason: "user background from the own API or a bundled SVG, SVG included; next/image optimization does not apply.",
  },
  {
    file: "ui/shell/console-backdrop.tsx",
    rules: ["@next/next/no-img-element"],
    reason: "user background from the own API or a bundled SVG, SVG included; next/image optimization does not apply.",
  },
  {
    file: "ui/session/session-card.tsx",
    rules: ["@next/next/no-img-element"],
    reason: "user background from the own API or a bundled SVG, SVG included; next/image optimization does not apply.",
  },
  {
    file: "ui/devices/device/agent-update-notice.tsx",
    rules: ["react-hooks/refs", "react-hooks/set-state-in-effect"],
    reason: "scopeRef and latest mirror the props in the render, and the scope effect clears data, error and receipt before the new load.",
  },
  {
    file: "ui/automation/desired-state-panel.tsx",
    rules: ["react-hooks/refs", "react-hooks/set-state-in-effect"],
    reason: "scopeRef.current follows the scope in the render, and effects clear data, source and result and set loading states before each fetch.",
  },
  {
    file: "ui/devices/management/device-network-panel.tsx",
    rules: ["react-hooks/refs", "react-hooks/set-state-in-effect"],
    reason: "live, editorRef and targetRef mirror props and editor in the render, and the scope effect resets the diagnostics state before the new client.",
  },
  {
    file: "ui/devices/management/device-services.tsx",
    rules: ["react-hooks/refs"],
    reason: "live.current takes the current props in the render so that service actions check the latest state after the await.",
  },
  {
    file: "ui/devices/management/device-system.tsx",
    rules: ["react-hooks/refs"],
    reason: "live.current takes the current props in the render so that system actions check the latest state after the await.",
  },
  {
    file: "ui/devices/management/device-firewall.tsx",
    rules: ["react-hooks/refs"],
    reason: "live.current takes the current props in the render so that a rule toggle in the row menu checks the latest device, rights and mode before it asks to confirm.",
  },
  {
    file: "ui/devices/management/device-tasks.tsx",
    rules: ["react-hooks/refs"],
    reason: "live.current takes the current props in the render so that a task toggle checks the latest device, rights and mode before it asks to confirm.",
  },
  {
    file: "ui/devices/management/device-updates.tsx",
    rules: ["react-hooks/refs"],
    reason: "live.current takes the current props in the render so that update actions check the latest state after the await.",
  },
  {
    file: "ui/devices/remote/file-browser.tsx",
    rules: ["react-hooks/refs", "react-hooks/set-state-in-effect"],
    reason: "scopeRef.current follows the scope in the render, and effects clear listing and selection on a device change and set busy before the fetch.",
  },
  {
    file: "ui/session/identity-entry.tsx",
    rules: ["react-hooks/set-state-in-effect"],
    reason: "The mount effect reads the invitation token from the URL and reports an invalid link directly through the error state.",
  },
  {
    file: "ui/session/mfa-step-up.tsx",
    rules: ["react-hooks/set-state-in-effect"],
    reason: "When the step-up dialog opens, the effect resets code, error, the pending passkey and the passkey status and loads the passkey status.",
  },
  {
    file: "ui/session/portal-recheck.tsx",
    rules: ["react-hooks/set-state-in-effect"],
    reason: "On an identity change, the effect aborts the running check and resets busy and error.",
  },
  {
    file: "ui/devices/remote/rdp-panel.tsx",
    rules: ["react-hooks/set-state-in-effect"],
    reason: "The effect calls discover, which sets the loading state at once, before it queries the RDP metadata.",
  },
  {
    file: "ui/devices/management/device-power.tsx",
    rules: ["react-hooks/refs"],
    reason: "live.current takes the current props in the render so that Review change checks the latest device, rights and mode before it asks to confirm a restart or shutdown.",
  },
  {
    file: "ui/devices/remote/remote-desktop-client.tsx",
    rules: ["react-hooks/set-state-in-effect"],
    reason: "The mount effect reads the device ID from the URL and sets the error state at once for an invalid ID.",
  },
  {
    file: "ui/session/session-gate.tsx",
    rules: [
      "@next/next/no-location-assign-relative-destination",
      "react-hooks/preserve-manual-memoization",
      "react-hooks/refs",
    ],
    reason: "After Sign out discarded the identity and MFA proofs, / reloads fully on purpose through window.location.assign, statusRef.current follows the status in the render, and check is memoized by hand.",
  },
  {
    file: "ui/devices/management/storage-panel.tsx",
    rules: ["react-hooks/refs", "react-hooks/set-state-in-effect"],
    reason: "current.current takes device and grant in the render, and the load effect sets the loading state before the fetch.",
  },
  {
    file: "ui/automation/runbook-panel.tsx",
    rules: ["react-hooks/refs", "react-hooks/set-state-in-effect"],
    reason: "currentScope.current follows the scope in the render, and effects set error, selection and tab when the device or the run changes.",
  },
  {
    file: "ui/devices/diagnostics/diagnostics-panels.tsx",
    rules: ["react-hooks/purity", "react-hooks/refs", "react-hooks/set-state-in-effect"],
    reason: "The render checks process inventory and wait time with Date.now() and mirrors props and generation in refs, and effects clear details, selection and filter on a device change.",
  },
  {
    file: "ui/automation/drift-panel.tsx",
    rules: ["react-hooks/purity", "react-hooks/refs", "react-hooks/set-state-in-effect"],
    reason: "The render reads Date.now() for the 24-hour age limit of reports and hands it to DriftOverview as now, scopeRef.current follows the scope, and the mount effect resets selection and editor.",
  },
  {
    file: "ui/devices/remote/terminal-panel.tsx",
    rules: ["react-hooks/immutability", "react-hooks/refs", "react-hooks/set-state-in-effect"],
    reason: "send reschedules itself through a timer, the Ctrl buttons read mfaNeeded.current in the render, and the session effect clears the session list before the fetch.",
  },
  {
    file: "lib/server/identity/policy/can.ts",
    rules: ["no-restricted-syntax"],
    reason: "The policy module imports globalOwnerGuard as the only SQL definition of the owner and passes it on through canSql.",
  },
  {
    file: "tests/ui/devices/agent-installation-download.mjs",
    rules: ["@typescript-eslint/no-this-alias"],
    reason: "The hook stub stores the rendering harness instance with active=this in render() so that useState and useEffect find their slots.",
  },
  {
    file: "tests/ui/session/identity-recovery-actions.mjs",
    rules: ["@typescript-eslint/no-this-alias"],
    reason: "The hook stub stores the rendering harness instance with active=this in render() so that useState and useEffect find their slots.",
  },
  {
    file: "tests/ui/session/local-identity-ui.mjs",
    rules: ["@typescript-eslint/no-this-alias"],
    reason: "The hook stub stores the rendering harness instance with active=this in render() so that useState and useEffect find their slots.",
  },
  {
    file: "tests/ui/settings/rbac-management-actions.mjs",
    rules: ["@typescript-eslint/no-this-alias"],
    reason: "The hook stub stores the rendering harness instance with active=this in render() so that useState and useEffect find their slots.",
  },
];

// Owner checks on the server go through lib/server/identity/policy/can.ts (can, requireCan,
// canSql, viewerCanSql). These selectors keep the older spellings out:
// - 'admin' compared with a role (role, x.role, x?.role, x['role']), in either
//   order;
// - ['admin',…].includes(<role>) unless the list holds all three roles, and
//   switch(<role>){case 'admin':};
// - x.permissions.includes('*') (also optional) and hasGlobalPermission(…,'*');
// - globalOwnerGuard imported, re-exported, destructured or read as a member.
// Client components and their helpers (ui/**) are not covered; they ask
// isOwner() in ui/base/access-capabilities.ts. A bare permissions variable
// (grant JSON in app/api/access/route.ts) is no viewer and stays legal.
const ownerPolicyMessage = "Owner checks go through lib/server/identity/policy/can.ts: can()/requireCan() before the commit, canSql()/viewerCanSql() in the commit.";
const equality = ":matches([operator='==='], [operator='!=='], [operator='=='], [operator='!='])";
const anyOf = (alternatives) => `:matches(${alternatives.join(", ")})`;
// The operand at `path` is role, x.role, x?.role, x['role'] or x?.['role'].
const roleOperand = (path) => anyOf([
  `[${path}.type='Identifier'][${path}.name='role']`,
  `[${path}.type='MemberExpression']${anyOf([`[${path}.property.name='role']`, `[${path}.property.value='role']`])}`,
  `[${path}.type='ChainExpression']${anyOf([`[${path}.expression.property.name='role']`, `[${path}.expression.property.value='role']`])}`,
]);
const adminComparedWith = (operand) => [
  `BinaryExpression${equality}[right.type='Literal'][right.value='admin']${operand("left")}`,
  `BinaryExpression${equality}[left.type='Literal'][left.value='admin']${operand("right")}`,
];
// The node at `path` names globalOwnerGuard as an identifier or a string literal.
const ownerGuardName = (path) => anyOf([`[${path}.name='globalOwnerGuard']`, `[${path}.value='globalOwnerGuard']`]);
const ownerPolicyFiles = ["lib/**/*.ts", "app/api/**/*.ts", "app/**/route.ts"];
const ownerPolicySelectors = [
  ...adminComparedWith(roleOperand),
  // Reports the 'admin' element. A list of all three roles only validates the
  // value (app/api/access/route.ts) and is no Owner check.
  `CallExpression[callee.type='MemberExpression'][callee.property.name='includes'][callee.object.type='ArrayExpression']${roleOperand("arguments.0")} > MemberExpression.callee > ArrayExpression.object:not(:has(> Literal[value='viewer']):has(> Literal[value='operator'])) > Literal[value='admin']`,
  `SwitchStatement${roleOperand("discriminant")} > SwitchCase[test.type='Literal'][test.value='admin']`,
  "CallExpression[callee.type='MemberExpression'][callee.property.name='includes'][callee.object.type='MemberExpression'][callee.object.property.name='permissions'][arguments.0.type='Literal'][arguments.0.value='*']",
  "CallExpression:matches([callee.name='hasGlobalPermission'], [callee.property.name='hasGlobalPermission'])[arguments.1.type='Literal'][arguments.1.value='*']",
  "ImportSpecifier[imported.name='globalOwnerGuard']",
  `ExportSpecifier${anyOf([ownerGuardName("local"), ownerGuardName("exported")])}`,
  `MemberExpression${ownerGuardName("property")}`,
  `ObjectPattern > Property${ownerGuardName("key")}`,
];

// SQL lives in domain modules under lib/server/, never in app/ or ui/: no import of
// the data layer, no db() call, no sql tag and no SQL statement literal. The
// literal check is case-sensitive, so UI text such as "Select a device" stays legal.
const databaseMessage = "Database access belongs in a domain module under lib/server/.";
const sqlStatement = String.raw`/^\s*(SELECT\s|INSERT INTO|UPDATE [A-Za-z_][A-Za-z0-9_]* SET|DELETE FROM|WITH [A-Za-z_][A-Za-z0-9_]* AS)\b/`;
const databaseSelectors = [
  "CallExpression[callee.type='Identifier'][callee.name='db']",
  "TaggedTemplateExpression[tag.type='Identifier'][tag.name='sql']",
  "TaggedTemplateExpression[tag.type='MemberExpression'][tag.object.name='sql']",
  "CallExpression[callee.type='MemberExpression'][callee.object.type='Identifier'][callee.object.name='sql']",
  `Literal[value=${sqlStatement}]`,
  `TemplateElement[value.raw=${sqlStatement}]`,
];
const databaseImports = ["error", {
  paths: ["@/lib/server/db", "postgres", "drizzle-orm"].map((name) => ({ name, message: databaseMessage })),
  patterns: [{ group: ["drizzle-orm/*", "@/db/*", "**/runtime/database.mjs", "**/lib/server/db", "**/lib/server/db.ts", "**/db/schema", "**/db/schema.ts"], message: databaseMessage }],
}];
const restricted = (selectors, message) => selectors.map((selector) => ({ selector, message }));

// Server-only code lives in lib/server/ (CONTRIBUTING.md, "Project layout"). Only the
// server side value-imports it: route handlers, runtime/, scripts/, lib/server/
// itself, instrumentation.ts and proxy.ts; tests load it as well. Everywhere else
// (ui/, app/ pages and layout, shared lib/) an import of lib/server/ is an error unless
// it is type-only. The rule has its own name, so it reports next to the database rule
// (no-restricted-imports) in app/ and ui/ instead of replacing it.
const serverBoundaryMessage = "Server-only code lives in lib/server/. Import it only from route handlers, runtime/, scripts/ and lib/server/; the client may import its types with import type.";
export const serverImporters = ["lib/server/**", "app/**/route.ts", "runtime/**", "scripts/**", "tests/**", "instrumentation.ts", "proxy.ts"];
const serverBoundary = ["error", {
  patterns: [{ group: ["@/lib/server/**", "./server/**", "../server/**", "../../server/**"], allowTypeImports: true, message: serverBoundaryMessage }],
}];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build and runtime directories (see .gitignore):
    "outputs/**",
    "work/**",
    "dist/**",
    ".data/**",
    ".vinext/**",
    ".build/**",
    "coverage/**",
    "agent/v3/bin/**",
    "agent/v3/obj/**",
    "e2e/.auth/**",
    "e2e/artifacts/**",
    // Generated source files:
    "agent/package-v3.ts",
    "drizzle/**",
  ]),
  {
    // typescript-eslint enables prefer-const only for TypeScript. Scripts,
    // tests and runtime modules in JavaScript get the same rule.
    files: ["**/*.{js,jsx,mjs,cjs}"],
    rules: {
      "prefer-const": "error",
    },
  },
  {
    files: ownerPolicyFiles,
    rules: {
      "no-restricted-syntax": ["error", ...restricted(ownerPolicySelectors, ownerPolicyMessage)],
    },
  },
  {
    files: ["app/**/*.{ts,tsx}", "ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": databaseImports,
      "no-restricted-syntax": ["error", ...restricted(databaseSelectors, databaseMessage)],
    },
  },
  {
    // Routes get both rule sets: one no-restricted-syntax entry replaces an earlier one.
    files: ["app/api/**/*.ts", "app/**/route.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...restricted(ownerPolicySelectors, ownerPolicyMessage), ...restricted(databaseSelectors, databaseMessage)],
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    ignores: serverImporters,
    rules: {
      "@typescript-eslint/no-restricted-imports": serverBoundary,
    },
  },
  ...lintExemptions.map(({ file, rules }) => ({
    files: [file],
    rules: Object.fromEntries(rules.map((rule) => [rule, "off"])),
  })),
]);

export default eslintConfig;
