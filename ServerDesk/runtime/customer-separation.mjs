// The one customer separation rule of the core (docs/customers.md). Plain
// JavaScript in runtime/, so plain Node.js code can use it without a TS loader.
import { sql } from './database.mjs';

// The id of the default customer (lib/default-customer.ts, migration 0029),
// repeated here for plain Node.js. tests/lib/customer-separation.mjs checks
// that both values are the same.
export const separationDefaultCustomerId = '00000000-0000-4000-8000-000000000100';

/**
 * SQL fragment that is true while a customer other than the default customer
 * exists. It becomes false again when the last other customer is deleted
 * (deleteCustomer in lib/server/identity/customer-admin.ts). The customer boundary, catalog separation, the enroll-without-customer rule,
 * customer assistant keys, the notification customer scope and
 * ConsoleData.multipleCustomers all use it. The fragment is an uncorrelated
 * EXISTS with its own alias and no parameters, so one statement can contain it
 * more than once.
 */
export const customerSeparationSql = sql`EXISTS (SELECT 1 FROM customers separation_customer WHERE separation_customer.id<>'00000000-0000-4000-8000-000000000100')`;
