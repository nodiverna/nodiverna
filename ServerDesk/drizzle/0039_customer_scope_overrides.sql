ALTER TABLE "alert_rule_overrides" DROP CONSTRAINT "alert_rule_overrides_scope_type_check";--> statement-breakpoint
ALTER TABLE "os_esu_overrides" DROP CONSTRAINT "os_esu_overrides_scope_type_check";--> statement-breakpoint
ALTER TABLE "alert_rule_overrides" ADD CONSTRAINT "alert_rule_overrides_scope_type_check" CHECK (scope_type IN ('global','customer','group','device'));--> statement-breakpoint
ALTER TABLE "os_esu_overrides" ADD CONSTRAINT "os_esu_overrides_scope_type_check" CHECK (scope_type IN ('customer','group','device'));--> statement-breakpoint
-- Written by hand below this line: the customer level of alert rules and ESU
-- dates. The new CHECKs only add 'customer', so every existing row stays valid
-- and unchanged. scope_id is polymorphic, so no foreign key removes the rows of
-- a deleted customer; these triggers do, like notification_rules_removed_customer.
-- They raise nothing.
CREATE FUNCTION alert_rule_overrides_removed_customer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM alert_rule_overrides WHERE scope_type='customer' AND scope_id=OLD.id;
 RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER alert_rule_overrides_removed_customer AFTER DELETE ON customers FOR EACH ROW EXECUTE FUNCTION alert_rule_overrides_removed_customer();--> statement-breakpoint
CREATE FUNCTION os_esu_overrides_removed_customer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM os_esu_overrides WHERE scope_type='customer' AND scope_id=OLD.id;
 RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER os_esu_overrides_removed_customer AFTER DELETE ON customers FOR EACH ROW EXECUTE FUNCTION os_esu_overrides_removed_customer();
