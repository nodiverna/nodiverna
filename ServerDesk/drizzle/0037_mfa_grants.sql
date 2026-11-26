CREATE TABLE "mfa_grants" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"principal" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entra_sign_in_flows" ADD COLUMN "grant_hash" text;--> statement-breakpoint
ALTER TABLE "mfa_grants" ADD CONSTRAINT "mfa_grants_user_id_local_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."local_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mfa_grants_expiry" ON "mfa_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_mfa_grants_principal" ON "mfa_grants" USING btree ("principal");--> statement-breakpoint
ALTER TABLE "entra_sign_in_flows" ADD CONSTRAINT "entra_sign_in_flows_grant" CHECK (grant_hash IS NULL OR purpose = 'sign-in');--> statement-breakpoint
DROP TABLE "mfa_browser_trust" CASCADE;--> statement-breakpoint
-- Written by hand below this line. The MFA grant (docs/portal-sessions.md,
-- "What each sign-in asks for") replaces the remembered browser: the drop above
-- ends every live remembered browser, and nothing is copied.
-- The switch "Ask for MFA after an automatic sign-out" now defaults to off. The
-- old save of the idle time stored '1' each time, so a stored value other than
-- '0' stays on only when the newest switch audit row ends with '→ an' (an
-- explicit Owner choice). A stored '0' stays '0', and a missing row stays missing.
UPDATE "identity_settings" SET "value" = CASE WHEN (SELECT "target" FROM "audit" WHERE "action" = 'MFA nach automatischer Abmeldung geändert' ORDER BY "at" DESC, "id" DESC LIMIT 1) LIKE '%→ an' THEN '1' ELSE '0' END WHERE "key" = 'session_idle_requires_mfa' AND "value" <> '0';
