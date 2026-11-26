CREATE TABLE "entra_group_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"group_object_id" text NOT NULL,
	"group_name" text DEFAULT '' NOT NULL,
	"role_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "entra_group_roles_group_id" CHECK (group_object_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "entra_group_roles_group_name" CHECK (length(group_name) <= 120),
	CONSTRAINT "entra_group_roles_scope_type" CHECK (scope_type IN ('global','devicegroup')),
	CONSTRAINT "entra_group_roles_global" CHECK ((scope_type = 'global') = (scope_id = '*'))
);
--> statement-breakpoint
CREATE TABLE "entra_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"enabled" smallint DEFAULT 0 NOT NULL,
	"tenant_id" text,
	"client_id" text,
	"credential_kind" text DEFAULT 'secret' NOT NULL,
	"secret_enc" text,
	"certificate_pem" text,
	"private_key_enc" text,
	"certificate_thumbprint" text,
	"certificate_expires_at" bigint,
	"revision" bigint DEFAULT 0 NOT NULL,
	"tested_revision" bigint,
	"tested_at" bigint,
	"test_result" text,
	"updated_at" bigint,
	"updated_by" text,
	CONSTRAINT "entra_settings_single_row" CHECK (id = 1),
	CONSTRAINT "entra_settings_enabled" CHECK (enabled IN (0,1)),
	CONSTRAINT "entra_settings_credential_kind" CHECK (credential_kind IN ('secret','certificate')),
	CONSTRAINT "entra_settings_test_result" CHECK (test_result IS NULL OR test_result IN ('ok','tenantNotFound','discoveryFailed','credentialRefused','secretExpired','certificateRefused','unreachable')),
	CONSTRAINT "entra_settings_revision" CHECK (revision >= 0),
	CONSTRAINT "entra_settings_complete" CHECK (enabled = 0 OR (tenant_id IS NOT NULL AND client_id IS NOT NULL AND ((credential_kind = 'secret' AND secret_enc IS NOT NULL) OR (credential_kind = 'certificate' AND certificate_pem IS NOT NULL AND private_key_enc IS NOT NULL AND certificate_thumbprint IS NOT NULL))))
);
--> statement-breakpoint
CREATE TABLE "entra_sign_in_flows" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"browser_hash" text NOT NULL,
	"nonce_hash" text NOT NULL,
	"code_verifier_enc" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"attempt_bucket" text NOT NULL,
	"attempt_window_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entra_user_groups" (
	"user_id" text NOT NULL,
	"group_object_id" text NOT NULL,
	CONSTRAINT "entra_user_groups_user_id_group_object_id_pk" PRIMARY KEY("user_id","group_object_id")
);
--> statement-breakpoint
ALTER TABLE "local_users" ADD COLUMN "identity_source" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "local_users" ADD COLUMN "entra_tenant_id" text;--> statement-breakpoint
ALTER TABLE "local_users" ADD COLUMN "entra_object_id" text;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "entra_group_roles" ADD CONSTRAINT "entra_group_roles_role_id_rbac_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."rbac_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entra_user_groups" ADD CONSTRAINT "entra_user_groups_user_id_local_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."local_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entra_group_roles_unique" ON "entra_group_roles" USING btree ("group_object_id","role_id","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "idx_entra_sign_in_flows_expires" ON "entra_sign_in_flows" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "local_users_entra" ON "local_users" USING btree ("entra_tenant_id","entra_object_id");--> statement-breakpoint
ALTER TABLE "local_users" ADD CONSTRAINT "local_users_identity_source" CHECK (identity_source IN ('local','entra'));--> statement-breakpoint
ALTER TABLE "local_users" ADD CONSTRAINT "local_users_entra_identity" CHECK ((identity_source = 'local' AND entra_tenant_id IS NULL AND entra_object_id IS NULL) OR (identity_source = 'entra' AND entra_tenant_id IS NOT NULL AND entra_object_id IS NOT NULL AND password_hash IS NULL AND must_reset = 0 AND auth_principal = 'entra:' || entra_tenant_id || ':' || entra_object_id));--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignment_source" CHECK (source IN ('manual','entra'));--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignment_entra_user" CHECK (source = 'manual' OR (principal_type = 'user' AND scope_type IN ('global','devicegroup')));