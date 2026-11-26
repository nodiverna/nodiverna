CREATE TABLE "dashboard_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"default_layout" text NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "dashboard_settings_single" CHECK (id = 1)
);
--> statement-breakpoint
ALTER TABLE "account_preferences" ADD COLUMN "dashboard_layout" text;