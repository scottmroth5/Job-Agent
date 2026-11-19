#!/usr/bin/env bash
# Rebuilds the server's settings files from Parameter Store (v3 Phase 5, as Health-Review does). deploy.sh runs it before every
# start on servers whose server.conf says ENV_SOURCE=ssm; it runs on the host with the instance role (containers cannot
# reach the instance metadata service: IMDSv2 with a hop limit of 1). Values are never printed; only counts are.
#
#   /job-agent/env/NAME      -> .env         the app and the backup container (DATABASE_URL is the app login's)
#   /job-agent/backup/NAME   -> backup.env   the backup container only: MIGRATE_DATABASE_URL, BACKUP_DATABASE_URL,
#                                                so the app never holds the logins that change the schema or read it all
#   /job-agent/service/<service>/DATABASE_URL and /job-agent/env/ by secrets.json -> state/env/<service>.env
#                                                the split layout only (server.conf LAYOUT=split, v3 Phase 7)
#
# Each SecureString parameter becomes NAME='value'. Refuses a name that is not NAME-shaped and a value holding a single
# quote or a line break, since compose reads the files. Everything is read into state/ (the deploy user's, mode 700)
# before any file changes, so a failed read leaves both files as they were; then each is copied over its file (the deploy
# user's, mode 600, made at first boot in the root-owned folder).
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

region="$(grep -x 'AWS_REGION=[a-z0-9-]*' server.conf | cut -d= -f2 || true)"
[[ -n "$region" ]] || { echo '[env] server.conf has no AWS_REGION line' >&2; exit 1; }

umask 077
app_tmp="$(mktemp state/env.XXXXXX)"
backup_tmp="$(mktemp state/env.XXXXXX)"
trap 'rm -f "$app_tmp" "$backup_tmp"; rm -rf state/env.new' EXIT

read_prefix() {
  local prefix="$1"
  aws ssm get-parameters-by-path --region "$region" --path "$prefix" --with-decryption --recursive --output json \
    --query 'Parameters[].{n:Name,v:Value}' \
  | PREFIX="$prefix" python3 -c '
import json, os, re, sys
prefix = os.environ["PREFIX"]
params = json.load(sys.stdin) or []
out = []
for p in sorted(params, key=lambda p: p["n"]):
    name = p["n"][len(prefix):] if p["n"].startswith(prefix) else None
    if not name or not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
        sys.exit(f"[env] a parameter name under {prefix} is not NAME-shaped")
    v = p["v"]
    if "\x27" in v or "\n" in v or "\r" in v:
        sys.exit(f"[env] {name} holds a single quote or a line break, which an env file cannot carry")
    out.append(f"{name}=\x27{v}\x27")
if not out:
    sys.exit(f"[env] no parameters found under {prefix}")
sys.stdout.write("\n".join(out) + "\n")
print(f"[env] {len(out)} settings read from {prefix}", file=sys.stderr)
'
}

read_prefix /job-agent/env/ > "$app_tmp"
read_prefix /job-agent/backup/ > "$backup_tmp"

# The split layout (v3 Phase 7, server.conf LAYOUT=split): one settings file per service, state/env/<service>.env, each
# holding only the settings secrets.json gives that service, and its own database login from
# /job-agent/service/<service>/DATABASE_URL. A parameter secrets.json does not list, or a service without its own login,
# stops everything before any file changes. Built in state/env.new, then swapped in after .env.
split=0
grep -qx 'LAYOUT=split' server.conf && split=1
if (( split )); then
  [[ -f secrets.json ]] || { echo '[env] LAYOUT=split needs secrets.json beside this script' >&2; exit 1; }
  rm -rf state/env.new
  mkdir -m 700 state/env.new
  aws ssm get-parameters-by-path --region "$region" --path /job-agent/service/ --with-decryption --recursive --output json \
    --query 'Parameters[].{n:Name,v:Value}' \
  | APP_ENV="$app_tmp" OUT=state/env.new python3 -c '
import json, os, re, sys
matrix = json.load(open("secrets.json"))
services = matrix["services"]
settings = matrix["settings"]
own = {}
for p in json.load(sys.stdin) or []:
    m = re.fullmatch(r"/job-agent/service/([a-z-]+)/([A-Z][A-Z0-9_]*)", p["n"])
    if not m or m.group(1) not in services or m.group(2) != "DATABASE_URL":
        sys.exit("[env] a parameter under /job-agent/service/ is not <service>/DATABASE_URL")
    v = p["v"]
    if "\x27" in v or "\n" in v or "\r" in v:
        sys.exit(f"[env] {m.group(1)} DATABASE_URL holds a single quote or a line break")
    own[m.group(1)] = f"DATABASE_URL=\x27{v}\x27"
lines = {}
for line in open(os.environ["APP_ENV"]).read().splitlines():
    name = line.split("=", 1)[0]
    if name not in settings:
        sys.exit(f"[env] {name} is not in secrets.json; add it there (with the services that need it) before LAYOUT=split")
    lines[name] = line
missing = [s for s in services if s not in own]
if missing:
    names = ", ".join(missing)
    sys.exit(f"[env] no own database login for: {names} (infra/db-setup.ps1 -ServiceLogins)")
for s in services:
    out = [own[s]] + [line for name, line in sorted(lines.items()) if name != "DATABASE_URL" and s in settings[name]["to"]]
    path = os.path.join(os.environ["OUT"], f"{s}.env")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(out) + "\n")
    print(f"[env] {s}: {len(out)} settings", file=sys.stderr)
'
fi

for f in .env backup.env; do
  [[ -f "$f" && -w "$f" ]] || { echo "[env] $f is missing or not writable (first boot creates it for the deploy user)" >&2; exit 1; }
done
cat "$app_tmp" > .env
cat "$backup_tmp" > backup.env
chmod 600 .env backup.env
if (( split )); then
  rm -rf state/env
  mv state/env.new state/env
fi
