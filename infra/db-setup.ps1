# Creates Job-Agent's database and its three logins on the shared RDS, and stores their addresses in Parameter Store
# (v3 Phase 5, as Health-Review does). The owner runs it once, from infra\, after terraform apply, signed in with aws login.
# Claude Code never runs it. The master login is Health-Review's RDS master: read into memory once, never stored.
#
#   powershell -ExecutionPolicy Bypass -File db-setup.ps1
#
# What it does:
#   1. Reads the database host, the master secret, the server id and the region from terraform output.
#   2. Reads RDS's master password from Secrets Manager into memory.
#   3. Makes three new random passwords (ja_migrate, ja_app, ja_backup) in memory.
#   4. Opens an SSM port forward through the server to RDS (the database has no public address).
#   5. Runs scripts\db-setup.js: logins and the C-collation database, then the grants. The certificate is checked against RDS's.
#   6. Stores the URLs as SecureString parameters encrypted with alias/job-agent:
#        /job-agent/env/DATABASE_URL                  ja_app (the app, and the backup service's run records)
#        /job-agent/backup/MIGRATE_DATABASE_URL       ja_migrate (the backup container only)
#        /job-agent/backup/BACKUP_DATABASE_URL        ja_backup (the backup container only)
# Nothing is printed but progress lines, and nothing is written to disk but the public CA bundle in the temp folder.
# Running it again resets the three passwords and the parameters (the app then needs a deploy.sh up).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Out($name) {
  $v = terraform output -raw $name
  if ($LASTEXITCODE -ne 0 -or -not $v) { throw "terraform output $name failed (run terraform apply first)" }
  return $v
}
function New-Password {
  $bytes = [byte[]]::new(32)
  # Create().GetBytes works in Windows PowerShell 5.1 as well as PowerShell 7 (Fill exists only in 7).
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

$dbHost = Out 'db_address'
$secretArn = Out 'db_master_secret_arn'
$instanceId = Out 'server_instance_id'
$region = Out 'region'
$localPort = 55433

Write-Host 'Reading the master login from Secrets Manager'
$master = aws secretsmanager get-secret-value --region $region --secret-id $secretArn --query SecretString --output text | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Could not read the master secret' }

$ca = Join-Path $env:TEMP 'rds-global-bundle.pem'
Invoke-WebRequest 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem' -OutFile $ca

$pw = @{ migrate = New-Password; app = New-Password; backup = New-Password }

Write-Host 'Opening the port forward to RDS through the server (SSM)'
$params = "host=$dbHost,portNumber=5432,localPortNumber=$localPort"
$forward = Start-Process aws -PassThru -WindowStyle Hidden -ArgumentList @(
  'ssm', 'start-session', '--region', $region, '--target', $instanceId,
  '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost', '--parameters', $params)
try {
  $ready = $false
  for ($i = 0; $i -lt 30 -and -not $ready; $i++) {
    Start-Sleep -Seconds 1
    $ready = (Test-NetConnection 127.0.0.1 -Port $localPort -WarningAction SilentlyContinue).TcpTestSucceeded
  }
  if (-not $ready) { throw 'The port forward did not open (is the Session Manager plugin installed and the server online in SSM?)' }

  $env:DB_SETUP_PORT = "$localPort"
  $env:DB_SETUP_HOST = $dbHost
  $env:DB_SETUP_CA = $ca
  $env:DB_MASTER_USER = $master.username
  $env:DB_MASTER_PASSWORD = $master.password
  $env:JA_MIGRATE_PASSWORD = $pw.migrate
  $env:JA_APP_PASSWORD = $pw.app
  $env:JA_BACKUP_PASSWORD = $pw.backup
  node ..\scripts\db-setup.js
  if ($LASTEXITCODE -ne 0) { throw 'db-setup.js failed; no parameters were stored' }
} finally {
  foreach ($n in 'DB_SETUP_PORT', 'DB_SETUP_HOST', 'DB_SETUP_CA', 'DB_MASTER_USER', 'DB_MASTER_PASSWORD', 'JA_MIGRATE_PASSWORD', 'JA_APP_PASSWORD', 'JA_BACKUP_PASSWORD') {
    Remove-Item "Env:$n" -ErrorAction SilentlyContinue
  }
  Stop-Process -Id $forward.Id -ErrorAction SilentlyContinue
}

$tail = "@${dbHost}:5432/job_agent?sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem"
$urls = [ordered]@{
  '/job-agent/env/DATABASE_URL'            = "postgres://ja_app:$($pw.app)$tail"
  '/job-agent/backup/MIGRATE_DATABASE_URL' = "postgres://ja_migrate:$($pw.migrate)$tail"
  '/job-agent/backup/BACKUP_DATABASE_URL'  = "postgres://ja_backup:$($pw.backup)$tail"
}
foreach ($name in $urls.Keys) {
  aws ssm put-parameter --region $region --name $name --type SecureString --key-id alias/job-agent --overwrite --value $urls[$name] | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not store $name" }
  Write-Host "Stored $name"
}
$pw = $null; $urls = $null; $master = $null
Write-Host 'Done. Next: env-to-ssm.ps1 for the rest of the settings.'
