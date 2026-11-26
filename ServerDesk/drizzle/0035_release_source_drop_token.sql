ALTER TABLE "agent_release_source" DROP CONSTRAINT "agent_release_source_token_check";--> statement-breakpoint
ALTER TABLE "agent_release_source" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "agent_release_source" DROP COLUMN "token_set_at";--> statement-breakpoint
ALTER TABLE "agent_release_source" DROP COLUMN "token_set_by";--> statement-breakpoint
-- Written by hand below this line. The portal reads the public repository
-- nodiverna/nodiverna without sign-in (docs/self-hosting.md, "Agent releases
-- from GitHub"): the stored GitHub token is gone with its columns above. A
-- source that stopped at "token rejected" asks for a new check, so the next
-- scheduler tick checks again without a token. The failed import rows with the
-- reason tokenRejected are removed; no other import row changes.
UPDATE agent_release_source SET last_error=NULL,last_status=NULL,requested_at=floor(extract(epoch from clock_timestamp())*1000)::bigint
 WHERE last_error='serverMessage.releaseImport.tokenRejected';--> statement-breakpoint
DELETE FROM agent_release_imports WHERE status='failed' AND reason='tokenRejected';
