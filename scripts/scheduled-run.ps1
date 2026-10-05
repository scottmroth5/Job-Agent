# The scheduled run (Windows Task Scheduler): the pipeline, then an inbox check, as separate steps so a
# failure in one never stops the other. Output goes to data/logs/scheduled-YYYY-MM-DD.log (gitignored);
# logs older than 60 days are removed. Register it with scripts/register-schedule.ps1.
param(
  [string]$Node = 'node'
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logDir = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("scheduled-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Write-Log([string]$text) {
  "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $text | Out-File -FilePath $log -Append -Encoding utf8
}

function Invoke-Step([string]$name, [string[]]$arguments) {
  Write-Log "=== $name ==="
  & $Node @arguments *>&1 | ForEach-Object { "$_" } | Out-File -FilePath $log -Append -Encoding utf8
  Write-Log "$name finished with exit code $LASTEXITCODE"
  return $LASTEXITCODE
}

Write-Log "Scheduled run started in $root"
$pipeline = Invoke-Step 'pipeline' @('--env-file=.env', 'scripts/pipeline.js')
$inbox = 0
if (Select-String -Path (Join-Path $root '.env') -Pattern '^GMAIL_REFRESH_TOKEN=.+' -Quiet) {
  $inbox = Invoke-Step 'inbox' @('--env-file=.env', 'scripts/inbox.js')
} else {
  Write-Log 'Inbox skipped: Gmail is not signed in (npm run inbox:auth).'
}

Get-ChildItem $logDir -Filter 'scheduled-*.log' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-60) } | Remove-Item -Force
Write-Log 'Scheduled run done'
exit ([Math]::Max($pipeline, $inbox))
