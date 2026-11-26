// The customer separation in a test database (runtime/customer-separation.mjs):
// the boundary, catalog separation and the other customer rules are active
// while a customer other than the default customer exists.
// - A customer other than the default customer exists only while the setting
//   "Multiple customers" is on (customer_settings, docs/customers.md):
//   enableMultipleCustomers() turns it on and runs before every insert of such a
//   customer, through SQL or createCustomer.
// - separateCustomers(at) inserts that second customer, unless one exists, for a
//   test that only needs the switch. Run enableMultipleCustomers() first.
// - A test whose fixture creates its customers first, and that checks the
//   behaviour without a boundary before its boundary phase, makes every account
//   a technician of every customer (everyCustomer) until that phase starts
//   (boundaryPhase removes exactly these assignments).
import {sql} from '../../runtime/database.mjs';

export const defaultCustomerId='00000000-0000-4000-8000-000000000100';
export const separationCustomerId='00000000-0000-4000-8000-0000000005e0';
const fixtureMark='fixture-every-customer';

/** The statement that turns the setting "Multiple customers" on, so a second customer may be inserted. */
export const enableMultipleCustomers=()=>sql`UPDATE customer_settings SET multiple_customers=true WHERE id=1 AND NOT multiple_customers`;
/** The statement that adds the second customer "Separation customer" at `at`, unless a customer other than the default one exists. */
export const separateCustomers=(at=Date.now())=>sql`INSERT INTO customers(id,name,created_at,updated_at) SELECT ${separationCustomerId},'Separation customer',${at},${at} WHERE NOT EXISTS (SELECT 1 FROM customers other_customer WHERE other_customer.id<>${defaultCustomerId})`;
/** Every account that exists now is assigned to every customer that exists now, so the boundary hides nothing. */
export const everyCustomer=(at=Date.now())=>sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) SELECT every_customer.id,'user',every_user.id,${at},${fixtureMark} FROM customers every_customer CROSS JOIN local_users every_user ON CONFLICT(customer_id,principal_type,principal_id) DO NOTHING`;
/** Ends everyCustomer: the boundary applies to every account that has no assignment of its own. */
export const boundaryPhase=()=>sql`DELETE FROM customer_assignments WHERE created_by=${fixtureMark}`;
