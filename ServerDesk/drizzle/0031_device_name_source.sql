CREATE TABLE "device_previous_names" (
	"server_id" text NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"replaced_at" bigint NOT NULL,
	CONSTRAINT "device_previous_names_pkey" PRIMARY KEY("server_id","name_key"),
	CONSTRAINT "device_previous_names_name_key_check" CHECK (name_key<>'')
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "name_source" text DEFAULT 'hostname' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_previous_names" ADD CONSTRAINT "device_previous_names_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_name_source_check" CHECK (name_source IN ('hostname','custom','pending'));--> statement-breakpoint
-- Written by hand below this line. Every existing device is classified once
-- (docs/device-workspace.md, "Device name"): without a snapshot it waits for
-- its first heartbeat (pending); a name equal to the reported computer name,
-- or a name that can be a Windows computer name (1 to 15 letters, digits or
-- hyphens), follows the computer name (hostname); any other name stays
-- (custom). No name changes here, and no audit row or previous name is
-- written: the next heartbeat applies the rename.
UPDATE servers SET name_source=CASE
 WHEN snapshot IS NULL THEN 'pending'
 WHEN lower(name)=lower(btrim(CASE WHEN snapshot IS JSON OBJECT THEN snapshot::jsonb->>'hostname' END)) THEN 'hostname'
 WHEN name ~ '^[A-Za-z0-9-]{1,15}$' THEN 'hostname'
 ELSE 'custom'
END;
