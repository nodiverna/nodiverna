#requires -Version 5.1
#requires -RunAsAdministrator
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
if(-not [Environment]::Is64BitProcess){throw 'Start this script in the 64-bit Windows PowerShell.'}
$Root=Join-Path $env:ProgramData 'ServerDesk'
if(Test-Path -LiteralPath (Join-Path $Root 'update-plan.bin')){throw 'An agent update is not complete yet. Let the update recovery finish first.'}
$Recovery=Get-ScheduledTask -TaskName 'ServerDesk Update Recovery' -ErrorAction SilentlyContinue
if($Recovery -and $Recovery.State -eq 'Running'){throw 'The agent update recovery is running. Wait until it finishes before you uninstall.'}
$Service=Get-Service -Name ServerDeskAgent -ErrorAction SilentlyContinue
if($Service -and $Service.Status -ne 'Stopped'){
 $StatePath=Join-Path $Root 'active-state.json'
 if(-not(Test-Path -LiteralPath $StatePath)){throw 'The service reports no state yet. Check the agent service before you uninstall.'}
 $State=Get-Content -LiteralPath $StatePath -Raw|ConvertFrom-Json
 if(([datetime]::UtcNow-([datetime]$State.at).ToUniversalTime()).TotalSeconds -gt 30){throw 'The service state is out of date. Check the agent service before you uninstall.'}
 if(@($State.runningJobs).Count -gt 0 -or $State.terminalActive -or $State.transfersActive -or $State.updatePending){throw 'A terminal, transfer or job is active. Close or finish it before you uninstall.'}
}
if(Test-Path -LiteralPath $Root){
 foreach($Item in @((Get-Item -LiteralPath $Root))+@(Get-ChildItem -LiteralPath $Root -Recurse -Force)){
  if($Item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'The agent folder contains links or reparse points. The uninstall was stopped.'}
 }
}
if($Service){
 Stop-Service -Name ServerDeskAgent
 $Service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[timespan]::FromSeconds(60))
 & sc.exe delete ServerDeskAgent|Out-Null
 if($LASTEXITCODE -ne 0){throw 'The agent service could not be removed. The agent files are kept.'}
}
if($Recovery){Unregister-ScheduledTask -TaskName 'ServerDesk Update Recovery' -Confirm:$false}
if(Test-Path -LiteralPath $Root){Remove-Item -LiteralPath $Root -Recurse -Force}
Write-Host 'ServerDesk service agent uninstalled. Also revoke the device in the dashboard.'
