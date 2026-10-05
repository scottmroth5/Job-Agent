# Registers (or updates) the Windows scheduled task that runs scripts/scheduled-run.ps1.
#   powershell -ExecutionPolicy Bypass -File scripts\register-schedule.ps1                      Mon and Thu at 6:00 AM
#   powershell -ExecutionPolicy Bypass -File scripts\register-schedule.ps1 -Time 7:30 -Days Monday,Wednesday,Friday
#   powershell -ExecutionPolicy Bypass -File scripts\register-schedule.ps1 -Remove
# The task runs as you, only while you are signed in, and starts as soon as possible after a missed time
# (for example when the computer was asleep or off).
param(
  [string]$Time = '6:00',
  [string[]]$Days = @('Monday', 'Thursday'),
  [string]$TaskName = 'Job Agent scheduled run',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "Removed the task '$TaskName'."
  return
}

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $PSScriptRoot 'scheduled-run.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Node `"$node`"" `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Days -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Job Agent: npm run pipeline, then npm run inbox. Logs in data\logs.' -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
$next = (Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime
Write-Output "Registered '$TaskName': $($Days -join ' and ') at $Time. Next run: $next"
Write-Output "Logs: $(Join-Path $root 'data\logs')"
