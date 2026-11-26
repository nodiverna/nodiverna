CREATE TABLE "device_dns_zone_records" (
	"server_id" text NOT NULL,
	"zone" text NOT NULL,
	"data" text NOT NULL,
	"record_count" integer NOT NULL,
	"truncated" boolean NOT NULL,
	"collected_at" bigint NOT NULL,
	"received_at" bigint NOT NULL,
	CONSTRAINT "device_dns_zone_records_pkey" PRIMARY KEY("server_id","zone"),
	CONSTRAINT "device_dns_zone_records_data_check" CHECK (data IS JSON OBJECT)
);
--> statement-breakpoint
ALTER TABLE "device_dns_zone_records" ADD CONSTRAINT "device_dns_zone_records_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Written by hand below this line. A removed device (revoked=1) loses its DNS
-- zone records together with its other plugin data, as
-- agent_plugins_removed_device of 0019_agent_plugins.sql does for
-- device_plugin_data. It raises nothing.
CREATE OR REPLACE FUNCTION agent_plugins_removed_device() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM device_plugin_data WHERE server_id=NEW.id;
 DELETE FROM device_dns_zone_records WHERE server_id=NEW.id;
 RETURN NULL;
END $$;
