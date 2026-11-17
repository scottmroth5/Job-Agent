# Job-Agent infrastructure (v3 Phase 5)

Production on PostgreSQL, set up like Health-Review's: Terraform, an EC2 server, settings in SSM Parameter Store, three database logins, a backup container, and connections that check the database's certificate. Job-Agent gets its own server inside Health-Review's network, and its own database and logins on Health-Review's RDS instance (the owner's decision, November 16, 2026).

**Health-Review isn't changed.** This stack only looks up its network, subnet, database firewall group and RDS instance (`shared.tf`). The one addition is a separate firewall rule that lets Job-Agent's server reach the database, and Health-Review's own applies leave it alone.

**The owner runs every plan and apply.** These steps spend money and touch production, so each is confirmed at the time; Claude Code runs none of them. CI only checks the Terraform's format, validity and security (Trivy), and never reaches AWS.

## What it makes
| Stack | Resources |
|---|---|
| `bootstrap/` (once) | Job-Agent's KMS key (`alias/job-agent`), and the encrypted, versioned S3 bucket that holds Terraform's state |
| `infra/` | The server, its firewall group, the rule into the shared database, its IAM role, the alarms, and the budget |

**The server:**
- EC2 t3a.small running Ubuntu 24.04;
- IMDSv2 only, so the containers can't reach the instance's credentials;
- a 30 GB disk encrypted with Job-Agent's key, and an Elastic IP;
- protected against termination.

**Its first boot** (`user-data.sh`):
- installs Docker, fail2ban, automatic security updates, and the CloudWatch agent;
- creates the `deploy` user, whose one key can only run `deploy.sh`;
- writes `server.conf`, which puts `deploy.sh` in PostgreSQL mode with settings from SSM.

**Its role** reads only `/job-agent/*` in Parameter Store.

**Alarms** (emailed through SNS, to the address in `terraform.tfvars`): the server's status check, CPU credit, memory, and disk. The shared RDS instance's alarms are Health-Review's.

**The budget:** $50 a month for everything tagged `app=job-agent`. It emails at 80% of actual spending and at 100% of forecast spending.

## Cost (confirm in the AWS calculator before creating anything)
About $21 a month, offset by $12 once the Lightsail server is deleted, so about $9 a month more:

| Item | Monthly |
|---|---|
| EC2 t3a.small | about $13.70 |
| Disk, 30 GB gp3 | $2.40 |
| Elastic IP | $3.65 |
| KMS key | $1 |
| Alarms | under $1 |

The shared RDS instance adds nothing unless it has to grow. If it runs short of memory, moving it to db.t4g.small costs about $12 a month more, and that change belongs in Health-Review's Terraform.

## One-time setup
1. **The tools:**
   - **Terraform 1.10 or newer** (CI uses 1.17.2), from HashiCorp's download page. It's a zip with one `terraform.exe`; put it in a folder on your PATH.
   - **AWS's Session Manager plugin**, from AWS's installer, which installs it where the AWS CLI finds it.

   In PowerShell, put quotes around a Terraform option that contains a dot, such as `"-backend-config=backend.hcl"`. Otherwise PowerShell splits it at the dot. `winget` isn't on every Windows install. Check with `terraform version` and `session-manager-plugin --version`. Then sign in with `aws login`, using the account that runs Health-Review.
2. **Turn on the cost tag:** in the Billing console, open Cost allocation tags and activate `app`. Until then the budget can't see Job-Agent's costs.
3. **Bootstrap:**
   ```
   cd infra\bootstrap
   copy terraform.tfvars.example terraform.tfvars
   ```
   Edit `terraform.tfvars` and choose a unique bucket name. Then:
   ```
   terraform init
   terraform apply
   ```
   Then move this stack's own state into the bucket it just made. Create `bootstrap/backend_override.tf` (it's gitignored) with an `s3` backend naming the bucket, key `job-agent/bootstrap.tfstate`, and `use_lockfile = true`. Then:
   ```
   terraform init -migrate-state
   ```
4. **Plan the main stack:**
   ```
   cd ..
   copy backend.hcl.example backend.hcl
   copy terraform.tfvars.example terraform.tfvars
   ```
   Fill both in. The deploy key is a new key pair; its private half goes into GitHub later. Then:
   ```
   terraform init "-backend-config=backend.hcl"
   terraform plan "-out=main.tfplan"
   ```
   Read the plan. It should only add Job-Agent's resources plus one firewall rule on the `health-review-db` group, and change nothing of Health-Review's.
5. **Apply it** with `terraform apply main.tfplan`. This takes a few minutes.
   - Confirm the SNS subscription email.
   - Check that first boot finished, through Session Manager: `aws ssm start-session --target <server_instance_id>`, then `cloud-init status`.
6. **Set up the database** with `powershell -ExecutionPolicy Bypass -File db-setup.ps1`. It:
   - creates the `job_agent` database and its three logins on the shared RDS;
   - stores the three addresses as SecureStrings under `/job-agent/env/` and `/job-agent/backup/`.

   Running it again resets the passwords.
7. **Copy the settings** for a staging rehearsal:
   ```
   powershell -ExecutionPolicy Bypass -File env-to-ssm.ps1 -Mode staging -Lightsail ubuntu@<lightsail address> -KeyFile <pem> -Site <staging app name> -DemoSite <staging demo name>
   ```
   It reads the Lightsail server's `.env` and Google sign-in files into memory only, and prints names only. Staging gets:
   - no schedules and no automatic runs;
   - no email to you and no Gmail inbox;
   - its own Drive backup folder.

## Rehearsal on staging names (done November 17, 2026)
These are the steps as they ran, cleanly, on November 17, 2026. The app needs its settings file (`data/config/job-search.json`), which arrives with the data load, so the data is loaded before the first start.

1. **Name the new server:** at the DNS provider, add A records for the two staging names, pointing at `server_public_ip`. In Google Cloud, add `https://<staging app name>/auth/google/callback` to the OAuth client's redirect addresses.
2. **Install the deploy files.** In a Session Manager session, as root:
   ```
   cd /opt/job-agent
   for f in compose.yml Caddyfile deploy.sh env-from-ssm.sh; do curl -fsSL -o $f https://raw.githubusercontent.com/scottmroth5/Job-Agent/main/deploy/$f; done
   chmod 755 deploy.sh env-from-ssm.sh
   ```
3. **Build the settings, make the tables, and load a copy of the real data:**
   ```
   sudo -u deploy ./env-from-ssm.sh
   export TAG=sha-<7>
   sudo -u deploy env COMPOSE_PROFILES=postgres IMAGE_TAG=$TAG docker compose run --rm --no-deps backup node scripts/migrate.js
   sudo -u deploy env COMPOSE_PROFILES=postgres IMAGE_TAG=$TAG docker compose run --rm --no-deps backup node scripts/backup-service.js load-from-backup
   ```
   `load-from-backup` reads the newest production backup and must end with "every table matches".
4. **First deploy:**
   ```
   sudo -u deploy ./deploy.sh deploy $TAG --no-backup
   ```
   `--no-backup` is needed because there's no earlier image on the server to back up with.
5. **Smoke tests:**
   - sign in, the jobs list and a job panel;
   - a letter download and an attachment;
   - add a note, then delete it;
   - the demo.

   Then run `backup-now` and `restore-test`, with the same `docker compose run ... backup node scripts/backup-service.js` line.

To load the data again later, first stop the app, the backup service and the demo. Then run `reset-database --confirm job_agent` before `load-from-backup`. The cut-over itself follows `docs/runbooks/postgres-cutover.md`.

## Files that stay on this PC (gitignored)
`terraform.tfvars`, `backend.hcl`, `*.tfplan`, `*.tfstate`, `.terraform/` and `bootstrap/backend_override.tf`. Neither the repo nor the image ever holds them: `.dockerignore` leaves out `infra/`.
