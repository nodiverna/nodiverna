CREATE TABLE "maintenance_lock" (
	"id" smallint PRIMARY KEY NOT NULL,
	"holder" text,
	"run_id" bigint,
	"acquired_at" bigint,
	"expires_at" bigint,
	CONSTRAINT "maintenance_lock_single_row" CHECK (id = 1),
	CONSTRAINT "maintenance_lock_holder" CHECK ((holder IS NULL) = (expires_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "maintenance_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"audit_days" integer,
	"job_days" integer,
	"run_at" smallint DEFAULT 180 NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint,
	"updated_by" text,
	CONSTRAINT "maintenance_settings_single_row" CHECK (id = 1),
	CONSTRAINT "maintenance_settings_audit_days" CHECK (audit_days BETWEEN 1 AND 3650),
	CONSTRAINT "maintenance_settings_job_days" CHECK (job_days BETWEEN 1 AND 3650),
	CONSTRAINT "maintenance_settings_run_at" CHECK (run_at BETWEEN 0 AND 1439),
	CONSTRAINT "maintenance_settings_time_zone" CHECK (length(time_zone) BETWEEN 1 AND 64),
	CONSTRAINT "maintenance_settings_revision" CHECK (revision >= 0)
);
--> statement-breakpoint
ALTER TABLE "maintenance_runs" ADD COLUMN "trigger" text DEFAULT 'cli' NOT NULL;--> statement-breakpoint
ALTER TABLE "maintenance_runs" ADD COLUMN "requested_by" text;--> statement-breakpoint
ALTER TABLE "maintenance_runs" ADD CONSTRAINT "maintenance_runs_trigger" CHECK (trigger IN ('schedule','continuation','manual','cli'));--> statement-breakpoint
-- Written by hand below this line: the single rows of the settings and of the
-- lock. The migration adds no trigger.
INSERT INTO maintenance_settings(id) VALUES(1);
INSERT INTO maintenance_lock(id) VALUES(1);
