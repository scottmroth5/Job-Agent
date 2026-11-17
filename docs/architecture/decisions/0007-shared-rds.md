# 0007: Production on PostgreSQL, set up like Health-Review, on its RDS instance

Status: accepted, 2026-11-16

## Context
Decision 0003 chose PostgreSQL on RDS for production, and Phase 4 made the app run on both engines (0006). The original plan for Phase 5 kept the Lightsail server and added a new RDS instance through VPC peering. By then Health-Review, the owner's other app, already ran on its own AWS stack: Terraform, an EC2 server, settings in SSM Parameter Store, an RDS PostgreSQL 18 instance, three database logins, a separate backup container, and connections that check the database's certificate.

## Decision
The owner decided on November 16, 2026:

- **Set it up like Health-Review.** Job-Agent ports the same pieces: `infra/` (Terraform, with a bootstrap stack), `server.conf` and `env-from-ssm.sh`, the backup container (`scripts/backup-service.js`), `deploy.sh`'s PostgreSQL mode, and the logins in `db/postgres/roles.ts`.
- **Share Health-Review's RDS instance.**
  - **What Job-Agent gets:** its own EC2 server inside Health-Review's network, and its own `job_agent` database with three logins on Health-Review's RDS instance.
  - **What stays Health-Review's:** Job-Agent's Terraform only looks Health-Review's resources up. It adds one separate firewall rule, which Health-Review's applies leave alone.
  - **What Job-Agent keeps separate:** its own KMS key (disk, Parameter Store, alert topic, state), its own Terraform state, and its own alarms and budget.
- **Three logins.**
  - **`ja_migrate`** owns the schema and runs `scripts/migrate.js` at deploy.
  - **`ja_app`** reads and writes rows, in deploy mode (it never migrates, and refuses to start while anything is pending).
  - **`ja_backup`** only reads, for `pg_dump`, with row security enabled and `app.uid=all` for its session.

  None of them is a superuser or bypasses row security.
- **Certificates:** in production, any address on another machine must use `verify-full` with the RDS bundle in the image.
- **The demo** keeps its own in-memory `demo-db` container (0006). **Local installs** stay on SQLite, so `better-sqlite3` stays a dependency, and `REQUIRE_POSTGRES=1` keeps the production app off SQLite instead.
- **Budget:** $50 a month for everything tagged `app=job-agent`.

## Alternatives considered
- **Job-Agent's own copy of Health-Review's whole stack** (VPC, EC2, RDS): about $35 a month against Lightsail's $12. It's the cleanest separation, but the second database instance is most of the cost.
- **Keep Lightsail and add RDS only** (the original plan): about $15 to $18 a month more. It needs VPC peering, and it differs from Health-Review's design, so the two apps would have two ways of doing the same thing.
- **Pause Phase 5:** SQLite on Lightsail works. But the owner wanted production on PostgreSQL, set up the way Health-Review is.

## Consequences
- **Cost:** about $21 a month for the new server, less Lightsail's $12 once it's deleted, so about $9 a month more. The shared RDS adds nothing unless it has to grow.
- **Shared fate:**
  - One RDS outage affects both apps.
  - Point-in-time recovery restores the whole instance, so Job-Agent restores itself from its own `pg_dump` backups, and point-in-time recovery is the last resort.
  - The instance had 141 MB free memory at its lowest before Job-Agent joined. If that gets tight, moving it to db.t4g.small (about $12 a month more) is a change in Health-Review's Terraform.
- **Health-Review's documentation** should note that its RDS instance hosts a second database. That's a one-line change, made in a Health-Review session.
- **Changes Health-Review's Terraform makes** to the shared network, subnet or database firewall group can affect Job-Agent. Its resource names are read through `shared_name` (default `health-review`).
- **The rehearsal (November 17)** found two gaps that tests on a superuser connection had hidden: `pg_dump` under row security, and the app's certificate rule for the demo. Both are fixed, and tests now run the three-login shape.
