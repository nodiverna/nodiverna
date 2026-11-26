CREATE TABLE "entra_directory_check" (
	"id" smallint PRIMARY KEY NOT NULL,
	"lease_until" bigint,
	"last_started_at" bigint,
	"last_finished_at" bigint,
	"last_result" text,
	"last_ok_at" bigint,
	"settings_revision" bigint,
	"checked_count" integer DEFAULT 0 NOT NULL,
	"locked_count" integer DEFAULT 0 NOT NULL,
	"group_change_count" integer DEFAULT 0 NOT NULL,
	"remaining_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "entra_directory_check_single_row" CHECK (id = 1),
	CONSTRAINT "entra_directory_check_result" CHECK (last_result IS NULL OR last_result IN ('ok','permissionMissing','credentialRefused','secretExpired','certificateRefused','unavailable')),
	CONSTRAINT "entra_directory_check_counts" CHECK (checked_count >= 0 AND locked_count >= 0 AND group_change_count >= 0 AND remaining_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "entra_settings" DROP CONSTRAINT "entra_settings_test_result";--> statement-breakpoint
ALTER TABLE "local_users" ADD COLUMN "entra_checked_at" bigint;--> statement-breakpoint
ALTER TABLE "entra_settings" ADD CONSTRAINT "entra_settings_test_result" CHECK (test_result IS NULL OR test_result IN ('ok','tenantNotFound','discoveryFailed','credentialRefused','secretExpired','certificateRefused','unreachable','graphPermissionMissing','graphUnreachable'));--> statement-breakpoint
-- Written by hand below this line. The single row of the account check through
-- Microsoft Graph: no lease and no run yet, like alert_sweep in 0005_alerts.sql.
INSERT INTO entra_directory_check(id) VALUES(1);
