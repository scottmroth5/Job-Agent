# Cut-over: production from Lightsail (SQLite) to the new server (PostgreSQL on the shared RDS)

v3 Phase 5. The owner runs every step; nothing here is automated. The rehearsal on the staging names (November 17, 2026) ran these same steps cleanly.

**Downtime:** the app and the demo are down from step 2 until DNS points at the new server in step 6, about 20 to 30 minutes. Nothing is lost: the Lightsail app is stopped before the final backup, so no write can come after it.

**What you need:**
- the Lightsail key (`data\ssh\LightsailDefaultKey-us-east-2.pem`);
- a Session Manager session on the new server (`aws ssm start-session --region us-east-2 --target <server_instance_id>`);
- the DNS provider's page for the domain;
- the GitHub repository's Settings, then Secrets and variables, then Actions;
- this PC on `main`, with `infra\terraform.tfvars` and `backend.hcl` in place.

## The day before
1. **Lower the DNS wait time:** at the DNS provider, set the TTL of the app's and the demo's A records to 600 seconds, so the switch in step 6 takes effect within 10 minutes.
2. **Check the new server:** sign in on staging, then run `./deploy.sh status` there and see every service healthy.

## The cut-over
1. **Snapshot Lightsail** (the way back, kept 14 days), from PowerShell:
   ```
   aws lightsail create-instance-snapshot --region us-east-2 --instance-name job-agent --instance-snapshot-name job-agent-before-postgres
   ```
2. **Stop Lightsail and take the final backup.** Over SSH as root in `/opt/job-agent`:
   ```
   docker compose stop app demo
   IMAGE_TAG=$(cat .deployed-tag) docker compose run --rm --no-deps app node scripts/backup.js
   ```
   The backup must print `Encrypted backup uploaded to Google Drive: jobs-<today>.jabk`. With the app stopped, nothing can change after this backup.
3. **Production settings for the new server.** From `infra` on this PC:
   ```
   pwsh -ExecutionPolicy Bypass -File env-to-ssm.ps1 -Mode production -Lightsail ubuntu@<Lightsail address> -KeyFile ..\data\ssh\LightsailDefaultKey-us-east-2.pem
   ```
   This replaces staging's settings with Lightsail's: the real names, the schedules, email and Gmail back on, the production backup folder, and automatic runs on.
4. **Load the final backup into RDS.** In Session Manager, as root in `/opt/job-agent`:
   ```
   sudo -u deploy ./env-from-ssm.sh
   export TAG=$(cat state/.deployed-tag)
   sudo -u deploy env COMPOSE_PROFILES=postgres docker compose stop app backup demo
   rm -rf data/config data/attachments
   sudo -u deploy env COMPOSE_PROFILES=postgres IMAGE_TAG=$TAG docker compose run --rm --no-deps backup node scripts/backup-service.js reset-database --confirm job_agent
   sudo -u deploy env COMPOSE_PROFILES=postgres IMAGE_TAG=$TAG docker compose run --rm --no-deps backup node scripts/backup-service.js load-from-backup
   ```
   - The `rm` clears the rehearsal's copies of the settings file and attachments, so the load writes today's.
   - `reset-database` keeps a checked dump of the rehearsal data first, then empties and migrates the database.
   - `load-from-backup` must name **today's** backup from step 2, end with `every table matches`, and write the settings file and attachments.
5. **Start the new server with the production settings:**
   ```
   sudo -u deploy ./deploy.sh up
   ```
   It must end with `Running sha-...`, with every service healthy.
6. **Move DNS:** at the DNS provider, point the app's and the demo's A records at the new server's IP (`terraform output -raw server_public_ip`). Delete the two staging records. Caddy gets certificates for the real names once they resolve, within a minute or two.
7. **Point GitHub's deploys at the new server.** In the repository's Actions secrets:
   - `DEPLOY_HOST`: the new IP.
   - `DEPLOY_USER`: `deploy`.
   - `DEPLOY_SSH_KEY`: the whole private key from `data\ssh\job-agent-deploy`.
   - `DEPLOY_KNOWN_HOSTS`: the output of `ssh-keyscan -t ed25519 <new IP>`. Check it first against the server's own fingerprint, in Session Manager: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, compared with `ssh-keyscan -t ed25519 <new IP> | ssh-keygen -lf -` on this PC.
8. **Smoke tests,** on the app's own address:
   1. sign in;
   2. the jobs list and a job panel;
   3. a cover letter download;
   4. on the Inbox screen, **Check now**;
   5. **Run pipeline** once (it spends a little on Claude and searches, as any run does);
   6. the demo.
9. **Backups on the new server:**
   ```
   sudo -u deploy env COMPOSE_PROFILES=postgres IMAGE_TAG=$TAG docker compose run --rm --no-deps backup node scripts/backup-service.js backup-now
   sudo -u deploy env COMPOSE_PROFILES=postgres IMAGE_TAG=$TAG docker compose run --rm --no-deps backup node scripts/backup-service.js restore-test
   ```
   The backup goes to the production folder "Job Agent Backups"; the restore test must say `ok`.
10. **Merge the documentation PR** that describes the new setup (PRIVACY.md, README, the architecture page). Its deploy is the first one that reaches the new server through GitHub, which confirms the secrets from step 7.

## The way back
- **Before writes reopen** (any step up to 8): point the two A records back at Lightsail's address, then over SSH on Lightsail:
  ```
  docker compose start app demo
  ```
  Lightsail's data is exactly as it was at step 2. Put the old GitHub secrets back if step 7 was done.
- **After writes reopen on the new server:** there is no automatic way back to SQLite. Fix forward on the new server. Its own backups (step 9), its pre-migration dumps, and RDS's 7-day point-in-time recovery hold the data. Point-in-time recovery restores the whole shared instance, Health-Review included, so it's the last resort.

## Afterwards
- **For 14 days:** Lightsail stays stopped as it is, never started while the new server runs, so there's never a second pipeline or inbox check. Delete it after the owner's OK, and its snapshot too. That saves $12 a month.
- **Check after a week:** the budget email has stayed quiet, the alarms have stayed quiet, and the scheduled runs, nightly backups and the monthly restore test have all succeeded. That's Phase 5's "a week of scheduled runs on RDS is clean".
- **The staging backup folder** in Drive ("Job Agent staging backups") can be deleted.
- **Clean-up at the DNS provider and Google:** set the DNS TTL back to its default, and remove the staging redirect address from the Google OAuth client.
