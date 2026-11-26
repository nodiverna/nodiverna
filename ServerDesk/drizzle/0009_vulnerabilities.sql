CREATE TABLE "vulnerabilities" (
	"cve_id" text PRIMARY KEY NOT NULL,
	"published" bigint,
	"last_modified" bigint,
	"severity" text NOT NULL,
	"score" double precision,
	"vector" text,
	"summary" text NOT NULL,
	"known_exploited" smallint DEFAULT 0 NOT NULL,
	"fetched_at" bigint NOT NULL,
	CONSTRAINT "vulnerabilities_id_check" CHECK (cve_id ~ '^CVE-[0-9]{4}-[0-9]{4,}$'),
	CONSTRAINT "vulnerabilities_severity_check" CHECK (severity IN ('critical','high','medium','low','none','unknown')),
	CONSTRAINT "vulnerabilities_known_exploited_check" CHECK (known_exploited IN (0,1))
);
--> statement-breakpoint
CREATE TABLE "vulnerability_products" (
	"product_id" text PRIMARY KEY NOT NULL,
	"cpe" text NOT NULL,
	"synced_at" bigint,
	"full_synced_at" bigint,
	"cve_count" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vulnerability_ranges" (
	"cve_id" text NOT NULL,
	"product_id" text NOT NULL,
	"version_exact" text,
	"version_start" text,
	"start_inclusive" smallint DEFAULT 0 NOT NULL,
	"version_end" text,
	"end_inclusive" smallint DEFAULT 0 NOT NULL,
	"synced_at" bigint NOT NULL,
	CONSTRAINT "vulnerability_ranges_flags_check" CHECK (start_inclusive IN (0,1) AND end_inclusive IN (0,1))
);
--> statement-breakpoint
CREATE TABLE "vulnerability_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"enabled" smallint DEFAULT 0 NOT NULL,
	"api_key" text,
	"revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint,
	"updated_by" text,
	CONSTRAINT "vulnerability_settings_single_row" CHECK (id = 1),
	CONSTRAINT "vulnerability_settings_enabled_check" CHECK (enabled IN (0,1)),
	CONSTRAINT "vulnerability_settings_revision_check" CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE TABLE "vulnerability_sync" (
	"id" smallint PRIMARY KEY NOT NULL,
	"lease_holder" text,
	"lease_until" bigint,
	"requested_at" bigint,
	"last_started_at" bigint,
	"last_finished_at" bigint,
	"last_success_at" bigint,
	"last_status" text,
	"last_error" text,
	CONSTRAINT "vulnerability_sync_single_row" CHECK (id = 1),
	CONSTRAINT "vulnerability_sync_status_check" CHECK (last_status IS NULL OR last_status IN ('ok','failed'))
);
--> statement-breakpoint
ALTER TABLE "vulnerability_ranges" ADD CONSTRAINT "vulnerability_ranges_cve_id_vulnerabilities_cve_id_fk" FOREIGN KEY ("cve_id") REFERENCES "public"."vulnerabilities"("cve_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vulnerability_ranges_product" ON "vulnerability_ranges" USING btree ("product_id","cve_id");--> statement-breakpoint
CREATE INDEX "idx_vulnerability_ranges_cve" ON "vulnerability_ranges" USING btree ("cve_id");--> statement-breakpoint
-- Written by hand below this line. The single rows of the settings (the check
-- is off until an Owner turns it on) and of the sync lease, like alert_sweep in
-- 0005_alerts.sql.
INSERT INTO vulnerability_settings(id,enabled,revision) VALUES(1,0,0);
INSERT INTO vulnerability_sync(id) VALUES(1);
