CREATE TABLE "alert_rule_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"enabled" smallint NOT NULL,
	"warning" integer,
	"critical" integer,
	"level" text,
	"actor" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "alert_rule_overrides_rule_id_scope_type_scope_id_key" UNIQUE("rule_id","scope_type","scope_id"),
	CONSTRAINT "alert_rule_overrides_scope_type_check" CHECK (scope_type IN ('global','group','device')),
	CONSTRAINT "alert_rule_overrides_scope_id_check" CHECK ((scope_type='global') = (scope_id='*')),
	CONSTRAINT "alert_rule_overrides_enabled_check" CHECK (enabled IN (0,1)),
	CONSTRAINT "alert_rule_overrides_level_check" CHECK (level IS NULL OR level IN ('info','warning','critical'))
);
--> statement-breakpoint
CREATE INDEX "idx_alert_rule_overrides_scope" ON "alert_rule_overrides" USING btree ("scope_type","scope_id");--> statement-breakpoint
-- Written by hand below this line: the cleanup triggers. scope_id is
-- polymorphic, so no foreign key removes the overrides of a removed device or
-- a deleted group; these triggers do, like automation_removed_device and
-- automation_removed_group in 0000_baseline.sql. They raise nothing.
CREATE FUNCTION alert_rule_overrides_removed_device() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM alert_rule_overrides WHERE scope_type='device' AND scope_id=NEW.id;
 RETURN NULL;
END $$;
CREATE TRIGGER alert_rule_overrides_removed_device AFTER UPDATE OF revoked ON servers FOR EACH ROW WHEN (NEW.revoked=1) EXECUTE FUNCTION alert_rule_overrides_removed_device();

CREATE FUNCTION alert_rule_overrides_removed_group() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM alert_rule_overrides WHERE scope_type='group' AND scope_id=OLD.id;
 RETURN NULL;
END $$;
CREATE TRIGGER alert_rule_overrides_removed_group AFTER DELETE ON device_groups FOR EACH ROW EXECUTE FUNCTION alert_rule_overrides_removed_group();
