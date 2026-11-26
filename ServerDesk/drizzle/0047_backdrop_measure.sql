ALTER TABLE "branding_assets" ADD COLUMN "measure_light_low" text;--> statement-breakpoint
ALTER TABLE "branding_assets" ADD COLUMN "measure_light_high" text;--> statement-breakpoint
ALTER TABLE "branding_assets" ADD COLUMN "measure_dark_low" text;--> statement-breakpoint
ALTER TABLE "branding_assets" ADD COLUMN "measure_dark_high" text;--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "branding_assets_measure_hex" CHECK (measure_light_low ~ '^#[0-9a-f]{6}$' AND measure_light_high ~ '^#[0-9a-f]{6}$' AND measure_dark_low ~ '^#[0-9a-f]{6}$' AND measure_dark_high ~ '^#[0-9a-f]{6}$');--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "branding_assets_measure_all" CHECK ((measure_light_low IS NULL AND measure_light_high IS NULL AND measure_dark_low IS NULL AND measure_dark_high IS NULL) OR (measure_light_low IS NOT NULL AND measure_light_high IS NOT NULL AND measure_dark_low IS NOT NULL AND measure_dark_high IS NOT NULL));--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "branding_assets_measure_console" CHECK (measure_light_low IS NULL OR slot = 'console');