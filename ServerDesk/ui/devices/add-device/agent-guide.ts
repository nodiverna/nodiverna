// Commands use the native installer's two services (SYSTEM broker ServerDeskAgent,
// unprivileged worker ServerDeskWorker) and their local-store paths. Stopping the
// broker with -Force stops the dependent worker as well.
// Keep them separate from JSX so the downloadable guide and UI share one source.
// Service Control Manager events 7031/7034: a ServerDesk service ended unexpectedly.
export const agentCrashEventsCommand = `Get-WinEvent -FilterHashtable @{
    LogName = 'System'
    ProviderName = 'Service Control Manager'
    Id = 7031, 7034
    StartTime = (Get-Date).AddDays(-1)
} -ErrorAction SilentlyContinue |
    Where-Object { $_.Message -match 'ServerDesk' } |
    Select-Object TimeCreated, Id, Message`;

// External store for the portal origin: the server render shows a placeholder,
// the client the origin the portal is currently opened under.
export const portalOriginSnapshot = () => window.location.origin;
export const portalOriginServerSnapshot = () => 'https://DEIN-PORTAL';
export const subscribePortalOrigin = (changed: () => void) => { window.addEventListener('popstate', changed); return () => window.removeEventListener('popstate', changed); };

// The registration file placeholder comes from the catalog (agents.install.registrationFile),
// so each UI language names the file to replace in its own word.
export const agentInstallCommand = (registrationFile: string) => `.\\ServerDesk.Agent.exe --install --config .\\${registrationFile}`;
export const agentRepairCommand = '.\\ServerDesk.Agent.exe --install';
export const agentUninstallCommand = '.\\ServerDesk.Agent.exe --uninstall';
export const agentStatusCommand = 'Get-Service -Name ServerDeskAgent,ServerDeskWorker';
export const agentStopCommand = 'Stop-Service -Name ServerDeskAgent -Force -ErrorAction Stop';
export const agentStartCommand = 'Start-Service -Name ServerDeskAgent,ServerDeskWorker -ErrorAction Stop';
export const agentRestartCommand = 'Restart-Service -Name ServerDeskAgent -Force -ErrorAction Stop; Start-Service -Name ServerDeskWorker -ErrorAction Stop';
export const agentLogsCommand = 'Get-Content -LiteralPath "$env:ProgramData\\ServerDesk\\worker\\agent-worker.log" -Tail 80 -Wait';
export const agentHealthCommand = 'Get-Content -LiteralPath "$env:ProgramData\\ServerDesk\\worker\\v3-health.json"';

// Runtime extraction files can be regenerated. Update plans, rollback releases,
// credentials and job/transfer state must never be included in this cleanup.
export const agentCacheCommand = String.raw`$agentRoot = Join-Path $env:ProgramData 'ServerDesk'
$agentCaches = @((Join-Path $agentRoot 'runtime'), (Join-Path $agentRoot 'worker\runtime'))
if ((Test-Path -LiteralPath (Join-Path $agentRoot 'update-plan.bin')) -or
    (Test-Path -LiteralPath (Join-Path $agentRoot 'install-maintenance.bin'))) {
    throw 'Finish the installation or update first.'
}
Stop-Service -Name ServerDeskAgent -Force -ErrorAction Stop
if ((Get-Service -Name ServerDeskAgent,ServerDeskWorker | Where-Object { $_.Status -ne 'Stopped' }) -or
    (Get-Process -Name ServerDesk.Agent -ErrorAction SilentlyContinue)) {
    throw 'The agent is still running. Nothing is deleted.'
}
foreach ($agentCache in $agentCaches) { if (Test-Path -LiteralPath $agentCache) {
    $cacheItem = Get-Item -LiteralPath $agentCache -Force -ErrorAction Stop
    $rootItem = Get-Item -LiteralPath $agentRoot -Force -ErrorAction Stop
    $links = @($rootItem, $cacheItem) + @(Get-ChildItem -LiteralPath $agentCache -Recurse -Force -ErrorAction Stop)
    if ($links | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
        throw 'Linked path: cleanup stopped.'
    }
    if ($cacheItem.FullName -ne [IO.Path]::GetFullPath($agentCache)) {
        throw 'Unexpected cache path: cleanup stopped.'
    }
    Get-ChildItem -LiteralPath $cacheItem.FullName -Force -ErrorAction Stop |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop }
} }
Start-Service -Name ServerDeskAgent,ServerDeskWorker -ErrorAction Stop`;

export function agentConnectivityCommand(portalOrigin:string) {
 // Only actual HTTP origins enter this displayed PowerShell literal. Apostrophes
 // are escaped independently of shell/JS interpolation.
 let origin='https://DEIN-PORTAL';
 try { const parsed=new URL(portalOrigin);if(parsed.protocol==='https:'&&parsed.username===''&&parsed.password==='')origin=parsed.origin; } catch {}
 return `$portal = '${origin.replaceAll("'","''")}'\nInvoke-WebRequest -Uri "$portal/api/health/live" -UseBasicParsing`;
}
