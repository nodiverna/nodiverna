// Runs once when a Next.js server process starts: the production server
// (server.js) and next dev. It starts the maintenance scheduler of this process
// (runtime/maintenance-scheduler.mjs), which also runs the periodic alarm check
// (runAlertSweep in lib/server/devices/alerts.ts) once a minute and right after it the
// notification dispatcher (runNotificationDispatch in lib/server/notifications/notifications.ts), and on its own busy flag the
// vulnerability check (runVulnerabilitySync in lib/server/devices/vulnerability-sync.ts) and on a fourth one the
// requested agent release check (runRequestedReleaseCheck in lib/server/agent/release-source.ts) and on a fifth one the
// account check of Microsoft Entra ID (runEntraDirectoryCheck in lib/server/identity/entra/directory-check.ts); the scheduler itself skips
// without DATABASE_URL or with MAINTENANCE_SCHEDULER=off, and a module reload
// never starts a second one.
export async function register(){
 if(process.env.NEXT_RUNTIME==='nodejs'){
  const {ensureMaintenanceScheduler}=await import('./runtime/maintenance-scheduler.mjs');
  const sweep=async(now:number)=>(await import('./lib/server/devices/alerts')).runAlertSweep(now);
  const dispatch=async(now:number)=>(await import('./lib/server/notifications/notifications')).runNotificationDispatch(now);
  const vulnerabilities=async(now:number)=>(await import('./lib/server/devices/vulnerability-sync')).runVulnerabilitySync(now);
  const releases=async(now:number)=>(await import('./lib/server/agent/release-source')).runRequestedReleaseCheck(now);
  const entraCheck=async(now:number)=>(await import('./lib/server/identity/entra/directory-check')).runEntraDirectoryCheck(now);
  await ensureMaintenanceScheduler(process.env,{sweep,dispatch,vulnerabilities,releases,entraCheck}).catch((error:unknown)=>console.error(`ServerDesk: Maintenance scheduler error: ${error instanceof Error?error.message:String(error)}`));
 }
}
