CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"name" text NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"inherit" smallint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "tags_scope_type_check" CHECK (scope_type IN ('device','group')),
	CONSTRAINT "tags_name_length_check" CHECK (char_length(name) BETWEEN 1 AND 64),
	CONSTRAINT "tags_name_trim_check" CHECK (name=btrim(name)),
	CONSTRAINT "tags_value_check" CHECK (char_length(value)<=256),
	CONSTRAINT "tags_inherit_check" CHECK (inherit IN (0,1)),
	CONSTRAINT "tags_inherit_scope_check" CHECK (scope_type='group' OR inherit=0)
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tags_scope_name" ON "tags" USING btree ("scope_type","scope_id",lower("name"));--> statement-breakpoint
CREATE INDEX "idx_tags_name_value" ON "tags" USING btree (lower("name"),"value");--> statement-breakpoint
-- Written by hand below this line: the cleanup triggers. scope_id is
-- polymorphic, so no foreign key removes the tags of a removed device or a
-- deleted group; these triggers do, like alert_rule_overrides_removed_device
-- and alert_rule_overrides_removed_group in 0001_alert_rule_overrides.sql.
-- They raise nothing.
CREATE FUNCTION tags_removed_device() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM tags WHERE scope_type='device' AND scope_id=NEW.id;
 RETURN NULL;
END $$;
CREATE TRIGGER tags_removed_device AFTER UPDATE OF revoked ON servers FOR EACH ROW WHEN (NEW.revoked=1) EXECUTE FUNCTION tags_removed_device();

CREATE FUNCTION tags_removed_group() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM tags WHERE scope_type='group' AND scope_id=OLD.id;
 RETURN NULL;
END $$;
CREATE TRIGGER tags_removed_group AFTER DELETE ON device_groups FOR EACH ROW EXECUTE FUNCTION tags_removed_group();
