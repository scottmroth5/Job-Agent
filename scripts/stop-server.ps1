# Stops the Job Agent server: ends the "Job Agent server" task, then the node process listening on the port.
#   npm run server:stop
#   npm run server:restart                       stop, then start the task again (after pulling or changing code)
#   powershell -ExecutionPolicy Bypass -File scripts\stop-server.ps1 [-Port 5178] [-KeepTask] [-Restart]
# Ending the task alone leaves node running (the task runs conhost, then cmd, then node, and only the first is
# stopped), so the old server would keep answering with old code. Only a node process whose command line runs
# server\index.js is stopped, never anything else on the port. -KeepTask skips ending the task (server-start.cmd
# uses it to clear a leftover server before starting a new one).
param([int]$Port = 5178, [switch]$KeepTask, [switch]$Restart)

$taskName = 'Job Agent server'
if (-not $KeepTask) {
  try { Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch {}
}

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($id in $listeners) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
  if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -match 'server[\\/]index\.js') {
    Stop-Process -Id $id -Force -Confirm:$false
    Write-Output "Stopped the server on port $Port (process $id)."
  } elseif ($p) {
    Write-Output "Port $Port is used by $($p.Name) (process $id), which is not the Job Agent server; left running."
    exit 1
  }
}

$free = $false
for ($i = 0; $i -lt 20; $i++) {
  if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { $free = $true; break }
  Start-Sleep -Milliseconds 500
}
if (-not $free) {
  Write-Output "Port $Port is still in use after 10 seconds."
  exit 1
}

if ($Restart) {
  try {
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Write-Output "Started the '$taskName' task again: http://localhost:$Port (ready in about 15 seconds)."
  } catch {
    Write-Output "The '$taskName' task is not registered. Run scripts\register-server-task.ps1, or npm run ui in a terminal."
    exit 1
  }
}
exit 0
