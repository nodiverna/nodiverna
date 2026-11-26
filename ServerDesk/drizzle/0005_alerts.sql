CREATE TABLE "alert_sweep" (
	"id" smallint PRIMARY KEY NOT NULL,
	"last_started_at" bigint,
	CONSTRAINT "alert_sweep_single_row" CHECK (id = 1)
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"key" text NOT NULL,
	"state" text NOT NULL,
	"level" text NOT NULL,
	"peak_level" text NOT NULL,
	"peak_value" double precision,
	"threshold" integer,
	"params" text NOT NULL,
	"started_at" bigint NOT NULL,
	"opened_at" bigint,
	"closed_at" bigint,
	"close_reason" text,
	"acknowledged_at" bigint,
	"acknowledged_by" text,
	"muted_until" bigint,
	"muted_by" text,
	CONSTRAINT "alerts_state_check" CHECK (state IN ('pending','open','closed')),
	CONSTRAINT "alerts_level_check" CHECK (level IN ('info','warning','critical')),
	CONSTRAINT "alerts_peak_level_check" CHECK (peak_level IN ('info','warning','critical')),
	CONSTRAINT "alerts_close_reason_check" CHECK (close_reason IS NULL OR close_reason IN ('recovered','rule-off','no-data')),
	CONSTRAINT "alerts_closed_check" CHECK ((state = 'closed') = (closed_at IS NOT NULL) AND (state = 'closed') = (close_reason IS NOT NULL)),
	CONSTRAINT "alerts_opened_check" CHECK ((state = 'pending') = (opened_at IS NULL)),
	CONSTRAINT "alerts_params_check" CHECK (params IS JSON)
);
--> statement-breakpoint
ALTER TABLE "alert_rule_overrides" ADD COLUMN "duration_minutes" integer;--> statement-breakpoint
ALTER TABLE "alert_rule_overrides" ADD COLUMN "recovery" integer;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_alerts_active" ON "alerts" USING btree ("server_id","rule_id","key") WHERE state <> 'closed';--> statement-breakpoint
CREATE INDEX "idx_alerts_server_started" ON "alerts" USING btree ("server_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_alerts_closed_at" ON "alerts" USING btree ("closed_at") WHERE state = 'closed';--> statement-breakpoint
-- Written by hand below this line. The single row of the alarm check lease,
-- like maintenance_lock in 0002_maintenance.sql.
INSERT INTO alert_sweep(id) VALUES(1);
-- Existing overrides of the alarm threshold rules get the catalog defaults of
-- the minimum duration and the recovery margin (lib/alert-rules.ts), so every
-- override keeps a complete set of settings.
UPDATE alert_rule_overrides SET duration_minutes=defaults.duration_minutes,recovery=defaults.recovery
 FROM (VALUES ('cpu',5,5),('memory',5,5),('pagefile',5,5),('disk-latency',5,10),('processor-queue',5,0),('disk-free',0,2),('signatures-age',0,0)) AS defaults(rule_id,duration_minutes,recovery)
 WHERE alert_rule_overrides.rule_id=defaults.rule_id;
-- A removed device (revoked=1) keeps no alarms, like
-- alert_rule_overrides_removed_device in 0001_alert_rule_overrides.sql. It raises nothing.
CREATE FUNCTION alerts_removed_device() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM alerts WHERE server_id=NEW.id;
 RETURN NULL;
END $$;
CREATE TRIGGER alerts_removed_device AFTER UPDATE OF revoked ON servers FOR EACH ROW WHEN (NEW.revoked=1) EXECUTE FUNCTION alerts_removed_device();
