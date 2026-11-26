ALTER TABLE "local_users" ADD COLUMN "entra_kept_owner_since" bigint;--> statement-breakpoint
-- Written by hand below this line. No backfill: the next account check sets the
-- marker when it keeps a last Owner that Entra reports disabled or deleted.