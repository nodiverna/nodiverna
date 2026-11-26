CREATE TABLE "security_alarms" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"user_id" text NOT NULL,
	"actor" text NOT NULL,
	"display_name" text NOT NULL,
	"address" text NOT NULL,
	"occurred_at" bigint NOT NULL,
	"acknowledged_at" bigint,
	"acknowledged_by" text,
	CONSTRAINT "security_alarms_kind" CHECK (kind IN ('emergencySignIn')),
	CONSTRAINT "security_alarms_acknowledged" CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL))
);
--> statement-breakpoint
ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_kind_check";--> statement-breakpoint
ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_alarm_check";--> statement-breakpoint
ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_suppressed_check";--> statement-breakpoint
ALTER TABLE "entra_settings" ADD COLUMN "entra_only" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "entra_settings" ADD COLUMN "emergency_user_id" text;--> statement-breakpoint
ALTER TABLE "entra_settings" ADD COLUMN "entra_only_at" bigint;--> statement-breakpoint
ALTER TABLE "entra_settings" ADD COLUMN "entra_only_by" text;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "recipients" text;--> statement-breakpoint
ALTER TABLE "notification_events" ADD COLUMN "security_alarm_id" text;--> statement-breakpoint
ALTER TABLE "security_alarms" ADD CONSTRAINT "security_alarms_user_id_local_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."local_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_security_alarms_open" ON "security_alarms" USING btree ("occurred_at") WHERE acknowledged_at IS NULL;--> statement-breakpoint
ALTER TABLE "entra_settings" ADD CONSTRAINT "entra_settings_emergency_user_id_local_users_id_fk" FOREIGN KEY ("emergency_user_id") REFERENCES "public"."local_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_security_alarm_id_security_alarms_id_fk" FOREIGN KEY ("security_alarm_id") REFERENCES "public"."security_alarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notification_events_security_alarm" ON "notification_events" USING btree ("security_alarm_id");--> statement-breakpoint
ALTER TABLE "entra_settings" ADD CONSTRAINT "entra_settings_entra_only" CHECK (entra_only IN (0,1));--> statement-breakpoint
ALTER TABLE "entra_settings" ADD CONSTRAINT "entra_settings_emergency" CHECK (entra_only = 0 OR emergency_user_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_recipients_check" CHECK (recipients IS NULL OR recipients IS JSON ARRAY);--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_emergency_check" CHECK ((kind = 'emergency') = (security_alarm_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_kind_check" CHECK (kind IN ('open','escalate','close','test','emergency'));--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_alarm_check" CHECK ((kind IN ('test','emergency')) = (alert_id IS NULL) AND (kind IN ('test','emergency')) = (server_id IS NULL) AND (kind = 'test') = (level IS NULL) AND (kind <> 'emergency' OR level = 'critical'));--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_suppressed_check" CHECK ((status = 'suppressed') = (suppressed_reason IS NOT NULL) AND (suppressed_reason IS NULL OR suppressed_reason IN ('muted','maintenance-window','not-notified','no-rule','no-recipient')));