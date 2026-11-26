ALTER TABLE "entra_sign_in_flows" ADD COLUMN "purpose" text DEFAULT 'sign-in' NOT NULL;--> statement-breakpoint
ALTER TABLE "entra_sign_in_flows" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "entra_sign_in_flows" ADD COLUMN "primary_hash" text;--> statement-breakpoint
ALTER TABLE "entra_sign_in_flows" ADD COLUMN "claim_hash" text;--> statement-breakpoint
ALTER TABLE "entra_sign_in_flows" ADD COLUMN "settings_revision" bigint;--> statement-breakpoint
ALTER TABLE "entra_sign_in_flows" ADD COLUMN "confirmed_at" bigint;--> statement-breakpoint
ALTER TABLE "entra_sign_in_flows" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "entra_sign_in_flows" ADD CONSTRAINT "entra_sign_in_flows_user_id_local_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."local_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entra_sign_in_flows_claim" ON "entra_sign_in_flows" USING btree ("claim_hash");--> statement-breakpoint
ALTER TABLE "entra_sign_in_flows" ADD CONSTRAINT "entra_sign_in_flows_purpose" CHECK (purpose IN ('sign-in','confirm'));--> statement-breakpoint
ALTER TABLE "entra_sign_in_flows" ADD CONSTRAINT "entra_sign_in_flows_confirm_fields" CHECK ((purpose = 'confirm' AND user_id IS NOT NULL AND primary_hash IS NOT NULL AND claim_hash IS NOT NULL AND settings_revision IS NOT NULL) OR (purpose = 'sign-in' AND user_id IS NULL AND primary_hash IS NULL AND claim_hash IS NULL AND settings_revision IS NULL AND confirmed_at IS NULL AND outcome IS NULL));--> statement-breakpoint
ALTER TABLE "entra_sign_in_flows" ADD CONSTRAINT "entra_sign_in_flows_result" CHECK (confirmed_at IS NULL OR outcome IS NULL);--> statement-breakpoint
ALTER TABLE "entra_sign_in_flows" ADD CONSTRAINT "entra_sign_in_flows_outcome" CHECK (outcome IS NULL OR outcome IN ('cancelled','expired','mfaMissing','wrongTenant','wrongAccount','staleSignIn','accountDisabled','tokenRejected','unavailable','notConfigured'));