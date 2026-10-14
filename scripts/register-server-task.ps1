# Registers (or replaces) the UI and API server as a Windows scheduled task that starts when you sign in, then
# starts it now so there is no need to sign out first.
#   powershell -ExecutionPolicy Bypass -File scripts\register-server-task.ps1
# Runs hidden (conhost --headless) until you sign out, restarts up to 3 times if it crashes, and logs the build,
# its startup line and errors to data\logs\server.log. The bind rules are unchanged (AUTH_MODE=none: 127.0.0.1 only).
# Restart after changing code:  npm run server:restart
# Stop it:                      npm run server:stop
# Remove it:                    Unregister-ScheduledTask -TaskName "Job Agent server"
$ErrorActionPreference = 'Stop'
$taskName = 'Job Agent server'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$wrapper = Join-Path $repo 'scripts\server-start.cmd'
$node = (Get-Command node).Source
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute 'conhost.exe' `
  -Argument "--headless cmd.exe /c `"`"$wrapper`" `"$node`"`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = 'PT30S'  # let the disk and network settle after sign-in
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Job Agent UI and API at http://localhost:5178 (npm run ui), started at sign-in.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Registered '$taskName' to start at sign-in using $node, and started it now: http://localhost:5178"
