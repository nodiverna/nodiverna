CREATE TABLE "agent_release_files" (
	"release_id" text NOT NULL,
	"path" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"chunks" text NOT NULL,
	CONSTRAINT "agent_release_files_release_id_path_pk" PRIMARY KEY("release_id","path"),
	CONSTRAINT "agent_release_files_size_check" CHECK (size > 0),
	CONSTRAINT "agent_release_files_sha256_check" CHECK (sha256 ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "agent_release_files_chunks_check" CHECK (chunks IS JSON ARRAY)
);
--> statement-breakpoint
CREATE TABLE "agent_release_imports" (
	"tag" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"version" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"release_id" text,
	"fingerprint" text,
	"attempted_at" bigint NOT NULL,
	CONSTRAINT "agent_release_imports_source_check" CHECK (source IN ('github','folder')),
	CONSTRAINT "agent_release_imports_status_check" CHECK (status IN ('imported','present','failed')),
	CONSTRAINT "agent_release_imports_reason_check" CHECK ((status = 'failed') = (reason IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "agent_release_source" (
	"id" smallint PRIMARY KEY NOT NULL,
	"token" text,
	"token_set_at" bigint,
	"token_set_by" text,
	"lease_holder" text,
	"lease_until" bigint,
	"requested_at" bigint,
	"last_started_at" bigint,
	"last_finished_at" bigint,
	"last_status" text,
	"last_error" text,
	CONSTRAINT "agent_release_source_single_row" CHECK (id = 1),
	CONSTRAINT "agent_release_source_status_check" CHECK (last_status IS NULL OR last_status IN ('ok','failed')),
	CONSTRAINT "agent_release_source_token_check" CHECK ((token IS NULL) = (token_set_at IS NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_release_files" ADD CONSTRAINT "agent_release_files_release_id_agent_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."agent_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_release_files_path" ON "agent_release_files" USING btree ("path");--> statement-breakpoint
CREATE INDEX "idx_agent_release_imports_attempted" ON "agent_release_imports" USING btree (attempted_at DESC);--> statement-breakpoint
-- Written by hand below this line. The single row of the release source
-- nodiverna/nodiverna: no token, no lease and no check yet, like
-- vulnerability_sync in 0009_vulnerabilities.sql.
INSERT INTO agent_release_source(id) VALUES(1);
