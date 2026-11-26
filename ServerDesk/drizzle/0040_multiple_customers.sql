CREATE TABLE "customer_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"multiple_customers" boolean NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint,
	"updated_by" text,
	CONSTRAINT "customer_settings_single_row" CHECK (id = 1),
	CONSTRAINT "customer_settings_revision" CHECK (revision >= 0)
);
--> statement-breakpoint
-- Written by hand below this line: the single row and the three triggers of the
-- setting "Multiple customers" (docs/customers.md). The start value is on when a
-- customer other than the default customer already exists, else off. No other
-- table changes its rows.
INSERT INTO customer_settings(id,multiple_customers) VALUES(1,EXISTS(SELECT 1 FROM customers WHERE id<>'00000000-0000-4000-8000-000000000100'));--> statement-breakpoint
-- While the setting is off, no customer other than the default customer is
-- inserted. FOR SHARE on the setting row: a concurrent switch-off and this
-- insert cannot both commit.
CREATE FUNCTION customers_insert_multiple_customers() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE enabled boolean;
BEGIN
 SELECT multiple_customers INTO enabled FROM customer_settings WHERE id=1 FOR SHARE;
 IF enabled IS NOT TRUE THEN RAISE EXCEPTION 'multiple-customers-off'; END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER customers_insert_multiple_customers BEFORE INSERT ON customers FOR EACH ROW WHEN (NEW.id<>'00000000-0000-4000-8000-000000000100') EXECUTE FUNCTION customers_insert_multiple_customers();--> statement-breakpoint
-- The setting goes from on to off only while no customer other than the default
-- customer exists (active or deactivated).
CREATE FUNCTION customer_settings_update_multiple() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM customers WHERE id<>'00000000-0000-4000-8000-000000000100') THEN RAISE EXCEPTION 'multiple-customers-in-use'; END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER customer_settings_update_multiple BEFORE UPDATE OF multiple_customers ON customer_settings FOR EACH ROW WHEN (OLD.multiple_customers AND NOT NEW.multiple_customers) EXECUTE FUNCTION customer_settings_update_multiple();--> statement-breakpoint
-- The row stays.
CREATE FUNCTION customer_settings_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'customer-settings-protected';
END $$;--> statement-breakpoint
CREATE TRIGGER customer_settings_delete BEFORE DELETE ON customer_settings FOR EACH ROW EXECUTE FUNCTION customer_settings_delete();
