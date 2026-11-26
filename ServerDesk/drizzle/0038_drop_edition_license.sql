-- Written by hand above the generated DROP TABLE. The portal has one edition:
-- the license row of 0000_baseline.sql goes away with its three triggers and
-- their functions. No other table changes, so customers, devices, groups,
-- assignments, installers and audit rows stay as they are.
DROP TRIGGER edition_license_delete ON "edition_license";--> statement-breakpoint
DROP TRIGGER edition_license_insert ON "edition_license";--> statement-breakpoint
DROP TRIGGER edition_license_update ON "edition_license";--> statement-breakpoint
DROP TABLE "edition_license" CASCADE;--> statement-breakpoint
DROP FUNCTION edition_license_delete();--> statement-breakpoint
DROP FUNCTION edition_license_insert();--> statement-breakpoint
DROP FUNCTION edition_license_update();
