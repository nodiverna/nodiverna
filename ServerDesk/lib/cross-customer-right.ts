// The cross-customer right (docs/customers.md) in one place for the
// server (lib/server/identity/access.ts) and the UI (ui/base/cross-customer.ts). No imports, so the
// client gets the constant without pulling in server code.
export const crossCustomerPermission='portal.msp.crossCustomer';
/** The catalog key of the right's name (en.ts, de.ts); ui/base/cross-customer.ts uses the same key. */
export const crossCustomerPermissionLabelKey='crossCustomer.right';
