CREATE TABLE "agent_integrity_events" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"event_id" text NOT NULL,
	"kind" text NOT NULL,
	"service" text,
	"target" text,
	"start_type" text,
	"reason" text,
	"user_name" text,
	"finding" text,
	"repaired" boolean,
	"planned" boolean DEFAULT false NOT NULL,
	"occurred_at" bigint NOT NULL,
	"received_at" bigint NOT NULL,
	CONSTRAINT "agent_integrity_events_server_id_event_id_key" UNIQUE("server_id","event_id"),
	CONSTRAINT "agent_integrity_events_kind_check" CHECK (kind IN ('service-stopped','service-ended','service-hung','service-restarted','broker-unresponsive','start-type-changed','agent-removed','protection-changed')),
	CONSTRAINT "agent_integrity_events_service_check" CHECK (service IS NULL OR service IN ('broker','worker')),
	CONSTRAINT "agent_integrity_events_target_check" CHECK (target IS NULL OR target IN ('service-dacl','service-sid','service-recovery','folder-agent','folder-plugins','folder-staging')),
	CONSTRAINT "agent_integrity_events_start_type_check" CHECK (start_type IS NULL OR start_type IN ('manual','disabled','unknown')),
	CONSTRAINT "agent_integrity_events_reason_check" CHECK (reason IS NULL OR reason IN ('local-uninstall','service-deleted')),
	CONSTRAINT "agent_integrity_events_user_name_check" CHECK (user_name IS NULL OR char_length(user_name) <= 256),
	CONSTRAINT "agent_integrity_events_finding_check" CHECK (finding IS NULL OR char_length(finding) <= 120)
);
--> statement-breakpoint
ALTER TABLE "agent_integrity_events" ADD CONSTRAINT "agent_integrity_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_integrity_events_server_received" ON "agent_integrity_events" USING btree ("server_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_agent_integrity_events_received" ON "agent_integrity_events" USING btree ("received_at");--> statement-breakpoint
-- Written by hand below this line. The integrity events keep no rows of a
-- removed device (revoked=1), like agent_plugins_removed_device in
-- 0019_agent_plugins.sql. It raises nothing.
CREATE FUNCTION agent_integrity_removed_device() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM agent_integrity_events WHERE server_id=NEW.id;
 RETURN NULL;
END $$;
CREATE TRIGGER agent_integrity_removed_device AFTER UPDATE OF revoked ON servers FOR EACH ROW WHEN (NEW.revoked=1) EXECUTE FUNCTION agent_integrity_removed_device();
