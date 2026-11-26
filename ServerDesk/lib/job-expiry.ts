// A pending job counts as expired once MAX(created_at,not_before) is older than
// this span. The heartbeat expires such jobs and the agent channel no longer
// delivers them, so both routes share this one bound.
export const PENDING_JOB_LIFETIME_MS=300000;
