CREATE TABLE "account_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"console_background" boolean DEFAULT true NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branding_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"signin_background" text DEFAULT 'none' NOT NULL,
	"console_background" text DEFAULT 'none' NOT NULL,
	"scheme_primary" text,
	"scheme_secondary" text,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "branding_settings_single" CHECK (id = 1),
	CONSTRAINT "branding_settings_signin_background" CHECK (signin_background IN ('none','upload','mist','dusk','tide','dune','slate','bloom')),
	CONSTRAINT "branding_settings_console_background" CHECK (console_background IN ('none','upload','mist','dusk','tide','dune','slate','bloom')),
	CONSTRAINT "branding_settings_scheme_primary" CHECK (scheme_primary ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "branding_settings_scheme_secondary" CHECK (scheme_secondary ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "branding_settings_scheme_pair" CHECK ((scheme_primary IS NULL) = (scheme_secondary IS NULL))
);
--> statement-breakpoint
ALTER TABLE "branding_assets" DROP CONSTRAINT "branding_assets_slot";--> statement-breakpoint
ALTER TABLE "branding_assets" DROP CONSTRAINT "branding_assets_size";--> statement-breakpoint
ALTER TABLE "account_preferences" ADD CONSTRAINT "account_preferences_user_id_local_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."local_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "branding_assets_background_portal" CHECK (slot NOT IN ('signin','console') OR customer_id IS NULL);--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "branding_assets_slot" CHECK (slot IN ('light','dark','icon','signin','console'));--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "branding_assets_size" CHECK (size = octet_length(data) AND size >= 1 AND (slot <> 'icon' OR size <= 262144) AND (slot NOT IN ('light','dark') OR size <= 2097152) AND (slot NOT IN ('signin','console') OR size <= 8388608));