-- Data only. The catalog lists only releases whose files the portal serves
-- (agent_release_files). Older rows without any file row (the built-in releases
-- of earlier images and record-only imports) can never be served, and their
-- versions would block the import of the same version: remove them and their
-- states. A planned update that names a release that is gone is cancelled; a
-- running update keeps its signed envelope and finishes. Import rows that point
-- to a removed release, and version conflicts with a version that is gone, are
-- forgotten, so the next check imports these releases again. A database with
-- only imported releases does not change.
DELETE FROM agent_releases r
 WHERE NOT EXISTS (SELECT 1 FROM agent_release_files f WHERE f.release_id = r.id);
--> statement-breakpoint
DELETE FROM agent_release_states s
 WHERE NOT EXISTS (SELECT 1 FROM agent_releases r WHERE r.id = s.release_id);
--> statement-breakpoint
UPDATE jobs SET state = 'cancelled', parameters = '{}', result = 'serverMessage.release.disabled'
 WHERE action = 'agent-update' AND state = 'pending'
   AND NOT EXISTS (SELECT 1 FROM agent_releases r
     WHERE r.id = (CASE WHEN jobs.parameters IS JSON OBJECT THEN jobs.parameters::jsonb ->> 'releaseId' END));
--> statement-breakpoint
DELETE FROM agent_release_imports i
 WHERE (i.release_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_releases r WHERE r.id = i.release_id))
    OR (i.status = 'failed' AND i.reason = 'versionConflict' AND NOT EXISTS (SELECT 1 FROM agent_releases r WHERE r.version = i.version));
