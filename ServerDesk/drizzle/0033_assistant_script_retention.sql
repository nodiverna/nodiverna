CREATE INDEX "idx_jobs_assistant_script" ON "jobs" USING btree ("created_at") WHERE action = 'assistant-powershell' AND display_input LIKE '%"script":%';--> statement-breakpoint
-- Written by hand below this line. The jobs whose display_input still holds an
-- assistant script: runMaintenance (runtime/maintenance.mjs) removes the script
-- after assistantScriptRetentionDays through this index.
