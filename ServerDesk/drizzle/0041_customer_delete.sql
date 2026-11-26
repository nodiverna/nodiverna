CREATE TABLE "removed_customers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"removed_at" bigint NOT NULL
);--> statement-breakpoint
-- Written by hand below this line: deleting a customer (docs/customers.md,
-- "Delete a customer"). History keeps the customer id: audit rows, notification
-- events, revoked device tombstones and archived runbooks and templates stay
-- unchanged, and removed_customers keeps the id with the last name. The delete
-- stays refused for the default customer and while live data holds the
-- customer: devices with revoked=0, device groups, runbooks and templates with
-- archived=0, and roles. The cascading AFTER DELETE triggers and the
-- assistant_keys foreign key stay as they are. No existing row changes.
DROP TRIGGER customers_delete_audit_guard ON "customers";--> statement-breakpoint
DROP FUNCTION customers_delete_audit_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION customers_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.id='00000000-0000-4000-8000-000000000100' THEN RAISE EXCEPTION 'customer-default-protected'; END IF;
 IF EXISTS(SELECT 1 FROM servers WHERE customer_id=OLD.id AND revoked=0) OR EXISTS(SELECT 1 FROM device_groups WHERE customer_id=OLD.id) THEN RAISE EXCEPTION 'customer-in-use'; END IF;
 RETURN OLD;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION customers_delete_catalog_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM runbooks WHERE customer_id=OLD.id AND archived=0) OR EXISTS(SELECT 1 FROM automation_templates WHERE customer_id=OLD.id AND archived=0) OR EXISTS(SELECT 1 FROM rbac_roles WHERE customer_id=OLD.id) THEN RAISE EXCEPTION 'customer-in-use'; END IF;
 RETURN OLD;
END $$;--> statement-breakpoint
-- The tombstone: the id and the last name, at the time of the delete in ms.
CREATE FUNCTION customers_delete_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO removed_customers(id,name,removed_at) VALUES(OLD.id,OLD.name,floor(extract(epoch FROM now())*1000)::bigint);
 RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER customers_delete_tombstone AFTER DELETE ON customers FOR EACH ROW EXECUTE FUNCTION customers_delete_tombstone();--> statement-breakpoint
-- The tombstones are append-only.
CREATE FUNCTION removed_customers_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'removed-customer-immutable';
END $$;--> statement-breakpoint
CREATE TRIGGER removed_customers_update BEFORE UPDATE ON removed_customers FOR EACH ROW EXECUTE FUNCTION removed_customers_immutable();--> statement-breakpoint
CREATE TRIGGER removed_customers_delete BEFORE DELETE ON removed_customers FOR EACH ROW EXECUTE FUNCTION removed_customers_immutable();--> statement-breakpoint
-- A removed id never names a customer again, so the history rows that keep it
-- never attach to a new customer: not by an insert and not by an id change.
CREATE FUNCTION customers_removed_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM removed_customers WHERE id=NEW.id) THEN RAISE EXCEPTION 'customer-id-removed'; END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER customers_insert_removed_id BEFORE INSERT ON customers FOR EACH ROW EXECUTE FUNCTION customers_removed_id();--> statement-breakpoint
CREATE TRIGGER customers_update_id_removed BEFORE UPDATE OF id ON customers FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id) EXECUTE FUNCTION customers_removed_id();
