CREATE TABLE "device_plugin_data" (
	"server_id" text NOT NULL,
	"plugin" text NOT NULL,
	"operation" text NOT NULL,
	"data" text NOT NULL,
	"summary" text NOT NULL,
	"collected_at" bigint NOT NULL,
	"received_at" bigint NOT NULL,
	CONSTRAINT "device_plugin_data_pkey" PRIMARY KEY("server_id","plugin","operation"),
	CONSTRAINT "device_plugin_data_data_check" CHECK (data IS JSON OBJECT),
	CONSTRAINT "device_plugin_data_summary_check" CHECK (summary IS JSON ARRAY)
);
--> statement-breakpoint
CREATE TABLE "plugin_release_files" (
	"release_id" text NOT NULL,
	"path" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"chunks" text NOT NULL,
	CONSTRAINT "plugin_release_files_release_id_path_pk" PRIMARY KEY("release_id","path"),
	CONSTRAINT "plugin_release_files_size_check" CHECK (size > 0),
	CONSTRAINT "plugin_release_files_sha256_check" CHECK (sha256 ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "plugin_release_files_chunks_check" CHECK (chunks IS JSON ARRAY)
);
--> statement-breakpoint
CREATE TABLE "plugin_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"manifest" text NOT NULL,
	"signature" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "plugin_releases_name_version_key" UNIQUE("name","version"),
	CONSTRAINT "plugin_releases_state_check" CHECK (state IN ('active','disabled'))
);
--> statement-breakpoint
ALTER TABLE "agent_release_imports" ADD COLUMN "kind" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_plugin_data" ADD CONSTRAINT "device_plugin_data_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_release_files" ADD CONSTRAINT "plugin_release_files_release_id_plugin_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."plugin_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_plugin_release_files_path" ON "plugin_release_files" USING btree ("path");--> statement-breakpoint
ALTER TABLE "agent_release_imports" ADD CONSTRAINT "agent_release_imports_kind_check" CHECK (kind IN ('agent','plugin'));--> statement-breakpoint
-- Written by hand below this line. The plugin data keep no rows of a removed
-- device (revoked=1), like health_signals_removed_device in
-- 0004_health_signals.sql. It raises nothing.
CREATE FUNCTION agent_plugins_removed_device() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM device_plugin_data WHERE server_id=NEW.id;
 RETURN NULL;
END $$;
CREATE TRIGGER agent_plugins_removed_device AFTER UPDATE OF revoked ON servers FOR EACH ROW WHEN (NEW.revoked=1) EXECUTE FUNCTION agent_plugins_removed_device();

-- The built-in roles are seeded with ON CONFLICT DO NOTHING (lib/rbac.ts), so
-- existing rows never get rights that a release adds. Add the plugin and
-- server role rights of docs/local-identity-rbac.md to the stored lists:
-- Reader gets dhcp.read and dns.read; Operator and Device Administrator get
-- plugins.manage, dhcp.read, dhcp.manage, dns.read and dns.manage. Only the
-- built-in rows change; custom and customer roles stay. A right that a row
-- already holds is not added again, so a second run and a run after a fresh
-- seed change nothing. The list keeps the JSON form of JSON.stringify.
UPDATE rbac_roles SET permissions='['||(
  SELECT string_agg(to_json(right_id)::text,',' ORDER BY position)
  FROM (
    SELECT value AS right_id,ordinality AS position FROM jsonb_array_elements_text(rbac_roles.permissions::jsonb) WITH ORDINALITY
    UNION ALL
    SELECT added.right_id,1000+added.position FROM (VALUES ('plugins.manage',1,false),('dhcp.read',2,true),('dhcp.manage',3,false),('dns.read',4,true),('dns.manage',5,false)) AS added(right_id,position,reader)
    WHERE (added.reader OR rbac_roles.id<>'builtin-reader')
      AND NOT (rbac_roles.permissions::jsonb ? added.right_id)
  ) AS rights
)||']'
 WHERE builtin=1
   AND id IN ('builtin-reader','builtin-operator','builtin-device-administrator')
   AND permissions IS JSON ARRAY
   AND NOT (permissions::jsonb ? '*')
   AND EXISTS (
    SELECT 1 FROM (VALUES ('plugins.manage',false),('dhcp.read',true),('dhcp.manage',false),('dns.read',true),('dns.manage',false)) AS needed(right_id,reader)
    WHERE (needed.reader OR rbac_roles.id<>'builtin-reader') AND NOT (rbac_roles.permissions::jsonb ? needed.right_id)
   );
