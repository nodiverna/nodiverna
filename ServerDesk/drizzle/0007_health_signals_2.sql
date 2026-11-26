CREATE TABLE "device_autostart" (
	"server_id" text NOT NULL,
	"id" text NOT NULL,
	"category" text NOT NULL,
	"scope" text NOT NULL,
	"location" text NOT NULL,
	"name" text NOT NULL,
	"command" text NOT NULL,
	"target" text,
	"signature" text NOT NULL,
	"signer" text,
	"publisher" text,
	"microsoft" smallint NOT NULL,
	"user_path" smallint NOT NULL,
	"first_seen" bigint NOT NULL,
	"baseline" smallint NOT NULL,
	"acknowledged_at" bigint,
	"acknowledged_by" text,
	CONSTRAINT "device_autostart_pkey" PRIMARY KEY("server_id","id"),
	CONSTRAINT "device_autostart_category_check" CHECK (category IN ('run','run-once','startup-folder','winlogon','service','task')),
	CONSTRAINT "device_autostart_scope_check" CHECK (scope IN ('machine','user')),
	CONSTRAINT "device_autostart_signature_check" CHECK (signature IN ('valid','invalid','unsigned','unknown')),
	CONSTRAINT "device_autostart_flags_check" CHECK (microsoft IN (0,1) AND user_path IN (0,1) AND baseline IN (0,1))
);
--> statement-breakpoint
CREATE TABLE "device_autostart_state" (
	"server_id" text PRIMARY KEY NOT NULL,
	"checksum" text NOT NULL,
	"reported_at" bigint NOT NULL,
	"count" integer NOT NULL,
	"truncated" smallint NOT NULL,
	"baseline_at" bigint NOT NULL,
	CONSTRAINT "device_autostart_state_truncated_check" CHECK (truncated IN (0,1))
);
--> statement-breakpoint
CREATE TABLE "device_driver_state" (
	"server_id" text PRIMARY KEY NOT NULL,
	"checksum" text NOT NULL,
	"reported_at" bigint NOT NULL,
	"count" integer NOT NULL,
	"truncated" smallint NOT NULL,
	CONSTRAINT "device_driver_state_truncated_check" CHECK (truncated IN (0,1))
);
--> statement-breakpoint
CREATE TABLE "device_drivers" (
	"server_id" text NOT NULL,
	"key" text NOT NULL,
	"device_name" text NOT NULL,
	"device_class" text,
	"inf_name" text,
	"file" text,
	"service" text,
	"provider" text,
	"version" text,
	"driver_date" text,
	"signed" smallint,
	"signer" text,
	CONSTRAINT "device_drivers_pkey" PRIMARY KEY("server_id","key"),
	CONSTRAINT "device_drivers_signed_check" CHECK (signed IS NULL OR signed IN (0,1))
);
--> statement-breakpoint
ALTER TABLE "device_autostart" ADD CONSTRAINT "device_autostart_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_autostart_state" ADD CONSTRAINT "device_autostart_state_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_driver_state" ADD CONSTRAINT "device_driver_state_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_drivers" ADD CONSTRAINT "device_drivers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_device_autostart_name_target" ON "device_autostart" USING btree ("name","target");--> statement-breakpoint
CREATE INDEX "idx_device_drivers_inf_version" ON "device_drivers" USING btree ("inf_name","version");--> statement-breakpoint
-- Written by hand below this line: the driver and autostart tables keep no
-- rows of a removed device (revoked=1), like health_signals_removed_device in
-- 0004_health_signals.sql. It raises nothing.
CREATE FUNCTION health_signals_2_removed_device() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM device_drivers WHERE server_id=NEW.id;
 DELETE FROM device_driver_state WHERE server_id=NEW.id;
 DELETE FROM device_autostart WHERE server_id=NEW.id;
 DELETE FROM device_autostart_state WHERE server_id=NEW.id;
 RETURN NULL;
END $$;
CREATE TRIGGER health_signals_2_removed_device AFTER UPDATE OF revoked ON servers FOR EACH ROW WHEN (NEW.revoked=1) EXECUTE FUNCTION health_signals_2_removed_device();
