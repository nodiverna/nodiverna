CREATE TABLE "plugin_ad_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"principal" text NOT NULL,
	"session_hash" text NOT NULL,
	"state" text NOT NULL,
	"source" text NOT NULL,
	"job_id" text,
	"server_id" text,
	"directory_kind" text NOT NULL,
	"directory_name" text NOT NULL,
	"directory_sid" text NOT NULL,
	"user_sid" text,
	"account" text,
	"upn" text,
	"created_at" bigint NOT NULL,
	"verified_at" bigint,
	"expires_at" bigint,
	CONSTRAINT "plugin_ad_sessions_state_check" CHECK (state IN ('pending','active')),
	CONSTRAINT "plugin_ad_sessions_source_check" CHECK (source IN ('password','entra')),
	CONSTRAINT "plugin_ad_sessions_directory_kind_check" CHECK (directory_kind IN ('domain','local')),
	CONSTRAINT "plugin_ad_sessions_active_check" CHECK (state <> 'active' OR (user_sid IS NOT NULL AND verified_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "plugin_ad_sessions" ADD CONSTRAINT "plugin_ad_sessions_session_hash_mfa_sessions_token_hash_fk" FOREIGN KEY ("session_hash") REFERENCES "public"."mfa_sessions"("token_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_plugin_ad_sessions_active" ON "plugin_ad_sessions" USING btree ("session_hash","directory_sid") WHERE state = 'active';--> statement-breakpoint
CREATE INDEX "idx_plugin_ad_sessions_job" ON "plugin_ad_sessions" USING btree ("job_id");