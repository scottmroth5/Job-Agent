# Copies the Lightsail server's settings into Parameter Store for the new server (v3 Phase 5, as Health-Review does). The owner
# runs it from infra\, signed in with aws login, after db-setup.ps1. Claude Code never runs it.
#
#   powershell -ExecutionPolicy Bypass -File env-to-ssm.ps1 -Mode staging -Lightsail <user@address> -KeyFile <pem> `
#     -Site <staging app name> -DemoSite <staging demo name>
#   powershell -ExecutionPolicy Bypass -File env-to-ssm.ps1 -Mode production -Lightsail <user@address> -KeyFile <pem>   (the cut-over)
#
# Reads /opt/job-agent/.env and the Google sign-in files over SSH into memory only (never to disk), then stores each
# setting as a SecureString parameter /job-agent/env/NAME encrypted with alias/job-agent. The secrets that must
# match stay identical (USER_KEY_SECRET seals users' keys, JOB_BACKUP_PASSPHRASE opens the backups, SESSION_SECRET
# keeps sign-ins, EMAIL_ENC_KEY opens stored emails). The Drive sign-in becomes GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.
# Staging changes: the site names, no scheduled jobs, no email to the owner (EMAIL_ADDRESS left out), no Gmail inbox
# (GMAIL_REFRESH_TOKEN left out, so a rehearsal never labels real mail), no automatic runs (AUTOMATIC_RUNS=off), and its own
# Drive backup folder.
# Production (the cut-over) keeps every setting as Lightsail has it. Parameters under /job-agent/env/ that the new set
# does not name are deleted, except DATABASE_URL (db-setup.ps1's). Prints names only, never values.
param(
  [Parameter(Mandatory)][ValidateSet('staging', 'production')][string]$Mode,
  [Parameter(Mandatory)][string]$Lightsail,
  [Parameter(Mandatory)][string]$KeyFile,
  [string]$Site,
  [string]$DemoSite
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if ($Mode -eq 'staging' -and (-not $Site -or -not $DemoSite)) { throw 'Staging needs -Site and -DemoSite (the temporary names)' }
$region = terraform output -raw region
if ($LASTEXITCODE -ne 0) { throw 'terraform output region failed' }

function Remote($path) {
  $text = ssh -i $KeyFile -o BatchMode=yes $Lightsail "sudo cat $path"
  if ($LASTEXITCODE -ne 0) { throw "Could not read $path on Lightsail" }
  return ($text -join "`n")
}

# KEY=value lines; quotes around a value are removed, comments and blank lines skipped.
$settings = [ordered]@{}
foreach ($line in (Remote '/opt/job-agent/.env') -split "`n") {
  $l = $line.Trim()
  if (-not $l -or $l.StartsWith('#')) { continue }
  $i = $l.IndexOf('=')
  if ($i -lt 1) { continue }
  $k = $l.Substring(0, $i).Trim()
  $v = $l.Substring($i + 1).Trim()
  if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) { $v = $v.Substring(1, $v.Length - 2) }
  if ($k -notmatch '^[A-Z][A-Z0-9_]*$') { throw "A setting name in .env is not NAME-shaped (line skipped would hide it)" }
  $settings[$k] = $v
}

# The Drive sign-in (backups, load-from-backup), as environment settings the app already reads.
if (-not $settings.Contains('GOOGLE_REFRESH_TOKEN')) {
  $token = Remote '/opt/job-agent/data/google/token.json' | ConvertFrom-Json
  if (-not $token.refresh_token) { throw 'token.json on Lightsail has no refresh token' }
  $settings['GOOGLE_REFRESH_TOKEN'] = $token.refresh_token
}
# The client usually comes from .env already (deploy/cloud.env.example); the file only when it does not.
if (-not ($settings.Contains('GOOGLE_CLIENT_ID') -and $settings.Contains('GOOGLE_CLIENT_SECRET'))) {
  $client = (Remote '/opt/job-agent/data/google/client_secret.json' | ConvertFrom-Json)
  $c = if ($client.installed) { $client.installed } else { $client.web }
  $settings['GOOGLE_CLIENT_ID'] = $c.client_id
  $settings['GOOGLE_CLIENT_SECRET'] = $c.client_secret
}

# Never carried over: anything the database setup and deploy.sh own.
foreach ($k in 'DATABASE_URL', 'DATA_DIR', 'REQUIRE_POSTGRES', 'DATABASE_MIGRATIONS') { $settings.Remove($k) }

if ($Mode -eq 'staging') {
  $settings['SITE_ADDRESS'] = $Site
  $settings['DEMO_SITE_ADDRESS'] = $DemoSite
  $settings['PUBLIC_URL'] = "https://$Site"
  $settings['BACKUP_DRIVE_FOLDER'] = 'Job Agent staging backups'
  # The copy's automatic runs (stored in the database) never run on staging: no Claude or search spending, no second pipeline.
  $settings['AUTOMATIC_RUNS'] = 'off'
  foreach ($k in @($settings.Keys)) {
    if ($k -like 'SCHEDULE_*' -or $k -eq 'EMAIL_ADDRESS' -or $k -eq 'GMAIL_REFRESH_TOKEN') { $settings.Remove($k) }
  }
} else {
  $settings.Remove('BACKUP_DRIVE_FOLDER')
  $settings.Remove('AUTOMATIC_RUNS')
}

foreach ($k in $settings.Keys) {
  $v = [string]$settings[$k]
  if (-not $v) { continue }
  if ($v.Contains("'") -or $v.Contains("`n")) { throw "$k holds a single quote or a line break, which the server's env file cannot carry" }
}

$prefix = '/job-agent/env/'
$keep = @('DATABASE_URL')
$existing = aws ssm get-parameters-by-path --region $region --path $prefix --query 'Parameters[].Name' --output json | ConvertFrom-Json
foreach ($name in $existing) {
  $k = $name.Substring($prefix.Length)
  if (-not $settings.Contains($k) -and $keep -notcontains $k) {
    aws ssm delete-parameter --region $region --name $name | Out-Null
    Write-Host "Deleted $name"
  }
}
foreach ($k in $settings.Keys) {
  $v = [string]$settings[$k]
  if (-not $v) { continue }
  aws ssm put-parameter --region $region --name "$prefix$k" --type SecureString --key-id alias/job-agent --overwrite "--value=$v" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not store $prefix$k" }
}
Write-Host "Stored $($settings.Count) settings under $prefix ($Mode)"
$settings = $null
