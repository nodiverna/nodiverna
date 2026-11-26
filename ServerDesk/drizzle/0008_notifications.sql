CREATE TABLE "notification_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"enabled" smallint NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"config" text NOT NULL,
	"secret" text,
	"target_hint" text NOT NULL,
	"revision" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "notification_channels_type_check" CHECK (type IN ('smtp','teams','webhook')),
	CONSTRAINT "notification_channels_name_check" CHECK (length(name) BETWEEN 1 AND 80),
	CONSTRAINT "notification_channels_enabled_check" CHECK (enabled IN (0,1)),
	CONSTRAINT "notification_channels_language_check" CHECK (language IN ('en','de')),
	CONSTRAINT "notification_channels_config_check" CHECK (config IS JSON OBJECT),
	CONSTRAINT "notification_channels_revision_check" CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"channel_id" text,
	"channel_name" text NOT NULL,
	"channel_type" text NOT NULL,
	"target_hint" text NOT NULL,
	"message_id" text,
	"status" text NOT NULL,
	"attempts" integer NOT NULL,
	"next_attempt_at" bigint,
	"sent_at" bigint,
	"last_attempt_at" bigint,
	"error_key" text,
	"error_params" text,
	"claimed_by" text,
	"claimed_at" bigint,
	"recovered" smallint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "notification_deliveries_type_check" CHECK (channel_type IN ('smtp','teams','webhook')),
	CONSTRAINT "notification_deliveries_status_check" CHECK (status IN ('pending','sending','sent','failed')),
	CONSTRAINT "notification_deliveries_sending_check" CHECK ((status = 'sending') = (claimed_by IS NOT NULL)),
	CONSTRAINT "notification_deliveries_sent_check" CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
	CONSTRAINT "notification_deliveries_attempts_check" CHECK (attempts BETWEEN 0 AND 10 AND recovered IN (0,1)),
	CONSTRAINT "notification_deliveries_error_params_check" CHECK (error_params IS NULL OR error_params IS JSON OBJECT)
);
--> statement-breakpoint
CREATE TABLE "notification_dispatch" (
	"id" smallint PRIMARY KEY NOT NULL,
	"last_started_at" bigint,
	CONSTRAINT "notification_dispatch_single_row" CHECK (id = 1)
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" text PRIMARY KEY NOT NULL,
	"alert_id" text,
	"server_id" text,
	"customer_id" text,
	"kind" text NOT NULL,
	"level" text,
	"rule_id" text,
	"key" text,
	"value" double precision,
	"threshold" integer,
	"close_reason" text,
	"occurred_at" bigint NOT NULL,
	"status" text NOT NULL,
	"suppressed_reason" text,
	"routed_at" bigint,
	CONSTRAINT "notification_events_kind_check" CHECK (kind IN ('open','escalate','close','test')),
	CONSTRAINT "notification_events_level_check" CHECK (level IS NULL OR level IN ('info','warning','critical')),
	CONSTRAINT "notification_events_alarm_check" CHECK ((kind = 'test') = (alert_id IS NULL) AND (kind = 'test') = (server_id IS NULL) AND (kind = 'test') = (level IS NULL)),
	CONSTRAINT "notification_events_close_reason_check" CHECK ((kind = 'close') = (close_reason IS NOT NULL) AND (close_reason IS NULL OR close_reason IN ('recovered','rule-off','no-data'))),
	CONSTRAINT "notification_events_status_check" CHECK (status IN ('pending','routed','suppressed')),
	CONSTRAINT "notification_events_suppressed_check" CHECK ((status = 'suppressed') = (suppressed_reason IS NOT NULL) AND (suppressed_reason IS NULL OR suppressed_reason IN ('muted','maintenance-window','not-notified','no-rule')))
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"levels" text NOT NULL,
	"on_open" smallint NOT NULL,
	"on_close" smallint NOT NULL,
	"on_escalate" smallint NOT NULL,
	"enabled" smallint NOT NULL,
	"revision" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "notification_rules_scope_channel_key" UNIQUE("scope_type","scope_id","channel_id"),
	CONSTRAINT "notification_rules_scope_type_check" CHECK (scope_type IN ('all','customer','group')),
	CONSTRAINT "notification_rules_scope_id_check" CHECK ((scope_type = 'all') = (scope_id = '*')),
	CONSTRAINT "notification_rules_levels_check" CHECK (levels IN ('["info"]','["warning"]','["critical"]','["info","warning"]','["info","critical"]','["warning","critical"]','["info","warning","critical"]')),
	CONSTRAINT "notification_rules_flags_check" CHECK (on_open IN (0,1) AND on_close IN (0,1) AND on_escalate IN (0,1) AND enabled IN (0,1) AND on_open + on_close + on_escalate >= 1),
	CONSTRAINT "notification_rules_revision_check" CHECK (revision >= 0)
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_id_notification_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."notification_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notification_channels_name" ON "notification_channels" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notification_deliveries_event_channel" ON "notification_deliveries" USING btree ("event_id","channel_id");--> statement-breakpoint
CREATE INDEX "idx_notification_deliveries_due" ON "notification_deliveries" USING btree ("channel_id","next_attempt_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_notification_deliveries_sending" ON "notification_deliveries" USING btree ("claimed_at") WHERE status = 'sending';--> statement-breakpoint
CREATE INDEX "idx_notification_deliveries_channel" ON "notification_deliveries" USING btree ("channel_id","last_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notification_events_open" ON "notification_events" USING btree ("alert_id") WHERE kind = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notification_events_close" ON "notification_events" USING btree ("alert_id") WHERE kind = 'close';--> statement-breakpoint
CREATE INDEX "idx_notification_events_alert" ON "notification_events" USING btree ("alert_id");--> statement-breakpoint
CREATE INDEX "idx_notification_events_pending" ON "notification_events" USING btree ("occurred_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_notification_events_occurred" ON "notification_events" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "idx_notification_rules_channel" ON "notification_rules" USING btree ("channel_id");--> statement-breakpoint
-- Written by hand below this line. The single row of the dispatcher lease,
-- like alert_sweep in 0005_alerts.sql.
INSERT INTO notification_dispatch(id) VALUES(1);
-- scope_id of notification_rules is polymorphic, so no foreign key removes the
-- rules of a deleted device group or customer; these triggers do, like
-- alert_rule_overrides_removed_group in 0001_alert_rule_overrides.sql. They raise nothing.
CREATE FUNCTION notification_rules_removed_group() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM notification_rules WHERE scope_type='group' AND scope_id=OLD.id;
 RETURN NULL;
END $$;
CREATE TRIGGER notification_rules_removed_group AFTER DELETE ON device_groups FOR EACH ROW EXECUTE FUNCTION notification_rules_removed_group();

CREATE FUNCTION notification_rules_removed_customer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM notification_rules WHERE scope_type='customer' AND scope_id=OLD.id;
 RETURN NULL;
END $$;
CREATE TRIGGER notification_rules_removed_customer AFTER DELETE ON customers FOR EACH ROW EXECUTE FUNCTION notification_rules_removed_customer();
