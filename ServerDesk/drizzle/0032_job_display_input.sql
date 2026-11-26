ALTER TABLE "jobs" ADD COLUMN "display_input" text DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Written by hand below this line. No backfill: jobs from before this migration
-- keep '{}' and the job drawer says that their input was not kept.
