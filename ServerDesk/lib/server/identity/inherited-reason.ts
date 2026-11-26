// Why an inherited role assignment gives no rights (effective: false), in one
// place for the server (lib/server/identity/rbac.ts) and the client (ui/kit/inheritance.tsx),
// like lib/cross-customer-right.ts. No imports, so the client gets the type
// without pulling in server code. The order is the order in which lib/server/identity/rbac.ts
// inheritedReason checks the reasons.
export const inheritedReasons=['role','user-inactive','group-disabled','group-empty','user-customer','group-customer'] as const;
export type InheritedReason=typeof inheritedReasons[number];
