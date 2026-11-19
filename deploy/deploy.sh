#!/usr/bin/env bash
# Deploys, rolls back, or reports the Job Agent app on the cloud server. Lives at /opt/job-agent/deploy.sh.
#
#   ./deploy.sh deploy <image tag>   pull that image, start it, wait for /healthz on the app and the demo; on failure,
#                                    go back to the last good one. When the image would change the database (its
#                                    migrations, tried first on a throwaway copy), an encrypted Drive backup is made with
#                                    the current image before it starts, the app keeps a checked pre-migration copy in
#                                    data/backups, and a failed deploy puts that copy back before the old image starts.
#   ./deploy.sh deploy <tag> --no-backup        the same without the Drive backup (emergency only)
#   ./deploy.sh deploy <tag> --skip-db-check    deploy an image that has no migration check (a tag older than 2026-10-25)
#   ./deploy.sh deploy <tag> --only <service>[,<service>...]   the split layout: replace those services alone (refused
#                                    when the tag's migrations differ from the running one's)
#   ./deploy.sh rollback             start the previous good image again
#   ./deploy.sh rollback <service>   the split layout: that service alone back to its previous tag (refused across a
#                                    schema change)
#   ./deploy.sh up                   start the current good image (after a reboot or a .env change)
#   ./deploy.sh status               the running tag and container health
#
# GitHub Actions reaches this script through a deploy key whose authorized_keys line forces this command, so the key
# can run nothing else: command="/opt/job-agent/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty
# In that case the requested words arrive in SSH_ORIGINAL_COMMAND and are checked below before anything runs.
#
# PostgreSQL servers (v3 Phase 5, like Health-Review's): ./server.conf (written at first boot by infra/user-data.sh; not
# secret) holds DB_ENGINE=postgres and ENV_SOURCE=ssm. Then .env and backup.env are rebuilt from Parameter Store before
# each start (env-from-ssm.sh), the backup container (compose profile postgres, image <tag>-backup) runs with the app,
# the app runs in deploy mode (it never migrates or opens SQLite), and a deploy that would migrate goes: pre-migrate (a
# pg_dump restored into a scratch cluster and migrated there first; the checked dump is kept in data/backups), the
# encrypted Drive backup with the current image, scripts/migrate.js as the owner login, then the new image; if it fails,
# the dump goes back over the database before the old image runs. Without server.conf (the Lightsail server) everything
# runs as before, on SQLite.
#
# The split layout (v3 Phase 7, decision 0010): server.conf LAYOUT=split (with DB_ENGINE=postgres and ENV_SOURCE=ssm) runs
# the app's roles as services of their own (compose.split.yml on top of compose.yml): worker-browser, worker-ai, worker-io,
# and the scheduler start first, the api last, so sign-in is down for seconds; each must answer /healthz. Each service's
# tag is kept in state/.tag-<service> (a full deploy sets them all), so one service can be replaced or rolled back alone.
# Removing the line and running ./deploy.sh up goes back to the one app container.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"
# Where deploy.sh keeps its own files: state/ when the folder exists (the EC2 server, where the deploy user may not write
# to /opt/job-agent itself), else this folder (the Lightsail server).
STATE_DIR=.
[[ -d state ]] && STATE_DIR=state
CURRENT_FILE="$STATE_DIR/.deployed-tag"
PREVIOUS_FILE="$STATE_DIR/.previous-tag"
HEALTH_WAIT_SECONDS=120

log() { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy] %s\n' "$*" >&2; exit 1; }

# Words from the forced SSH command, else from the command line. No shell expansion of what the client sent.
if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  read -r -a ARGS <<< "$SSH_ORIGINAL_COMMAND"
else
  ARGS=("$@")
fi
ACTION="${ARGS[0]:-status}"
TAG="${ARGS[1]:-}"
OPTION="${ARGS[2]:-}"
ONLY="${ARGS[3]:-}"
[[ ${#ARGS[@]} -le 4 ]] || fail "Too many arguments."
[[ -z "$OPTION" || "$OPTION" == --no-backup || "$OPTION" == --skip-db-check || "$OPTION" == --only ]] || fail "Unknown option \"$OPTION\"."
[[ "$OPTION" == --only || -z "$ONLY" ]] || fail "Too many arguments."

# server.conf is read by matching whole lines, never sourced.
conf() { [[ -f server.conf ]] && grep -qx "$1" server.conf; }
POSTGRES=0
SPLIT=0
SERVICES=(app demo)
# The split layout's roles, in start order: the api last.
ROLES=(worker-browser worker-ai worker-io scheduler api)
if conf 'DB_ENGINE=postgres'; then
  POSTGRES=1
  SERVICES+=(backup)
  # The backup service's profile, and the app's deploy mode (compose.yml reads these two).
  export COMPOSE_PROFILES=postgres JA_REQUIRE_POSTGRES=1 JA_DATABASE_MIGRATIONS=deploy
fi
if conf 'LAYOUT=split'; then
  (( POSTGRES )) && conf 'ENV_SOURCE=ssm' && [[ -d state ]] || fail "LAYOUT=split needs DB_ENGINE=postgres, ENV_SOURCE=ssm, and the state folder."
  SPLIT=1
  export COMPOSE_FILE=compose.yml:compose.split.yml
  SERVICES=("${ROLES[@]}" demo backup)
fi

valid_tag() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; }
is_role() { local r; for r in "${ROLES[@]}"; do [[ "$r" == "$1" ]] && return 0; done; return 1; }

# One deploy at a time, even if two pushes land close together.
exec 9> "$STATE_DIR/.deploy.lock"
flock -w 600 9 || fail "Another deploy is still running."

compose() { IMAGE_TAG="$1" docker compose "${@:2}"; }

# The split layout's per-service tags: TAG_<SERVICE> (compose.split.yml) from state/.tag-<service>, or none (IMAGE_TAG).
tag_var() { local v="${1^^}"; echo "TAG_${v//-/_}"; }
service_tag() { cat "$STATE_DIR/.tag-$1" 2>/dev/null || true; }
load_tags() { local r t; for r in "${ROLES[@]}"; do t="$(service_tag "$r")"; if [[ -n "$t" ]]; then export "$(tag_var "$r")=$t"; else unset "$(tag_var "$r")"; fi; done; }
clear_tags() { local r; for r in "${ROLES[@]}"; do unset "$(tag_var "$r")"; done; }
# Records a service's new tag, keeping the one before for rollback <service>.
set_service_tag() {
  local old; old="$(service_tag "$1")"
  if [[ -n "$old" && "$old" != "$2" ]]; then echo "$old" > "$STATE_DIR/.prev-tag-$1"; fi
  echo "$2" > "$STATE_DIR/.tag-$1"
}

# The settings from Parameter Store (servers with ENV_SOURCE=ssm), refreshed before every start.
refresh_env() {
  if conf 'ENV_SOURCE=ssm'; then ./env-from-ssm.sh || fail "Could not read the settings from Parameter Store; nothing changed."; fi
}

# A one-off backup container of this tag (PostgreSQL servers): scripts/backup-service.js <command>.
backup_run() { local tag="$1"; shift; IMAGE_TAG="$tag" docker compose run --rm --no-deps -T backup node scripts/backup-service.js "$@"; }

# The port each service answers /healthz on, inside its own container.
health_port() { case "$1" in worker-*|scheduler) echo 5180 ;; *) echo 5178 ;; esac; }

# Each service named (default: the app and the public demo, or every role and the demo) must answer /healthz before a
# deploy counts as good.
healthy() {
  local waited=0 service port
  local names=("$@")
  if (( ${#names[@]} == 0 )); then
    if (( SPLIT )); then names=("${ROLES[@]}" demo); else names=(app demo); fi
  fi
  for service in "${names[@]}"; do
    port="$(health_port "$service")"
    while (( waited < HEALTH_WAIT_SECONDS )); do
      if docker compose exec -T "$service" node -e "fetch('http://127.0.0.1:$port/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
        break
      fi
      sleep 3
      waited=$(( waited + 3 ))
    done
    (( waited < HEALTH_WAIT_SECONDS )) || { log "$service is not answering /healthz"; return 1; }
  done
  return 0
}

# A one-off container of the app's image, with the app's settings and data folder (runs as uid 1000, like the app).
app_run() { local tag="$1"; shift; IMAGE_TAG="$tag" docker compose run --rm --no-deps -T "$@"; }

# Would this image change the database? Its own check runs the migrations on a throwaway copy: exit 0 none, 10 some (a
# migration that fails on this data fails here, before the real file is touched).
db_check() {
  local tag="$1" code=0
  app_run "$tag" app node scripts/migrations-pending.js || code=$?
  return "$code"
}

# The last migration a tag's code knows (scripts/migrations-list.js prints its id), so one service is never started on a
# schema its code does not match.
schema_of() { IMAGE_TAG="$1" docker compose pull -q app >/dev/null 2>&1 || true; app_run "$1" app node scripts/migrations-list.js; }
same_schema() {
  local a b
  a="$(schema_of "$1")" || fail "Could not read the migrations of $1."
  b="$(schema_of "$2")" || fail "Could not read the migrations of $2."
  [[ -n "$a" && "$a" == "$b" ]]
}

# Puts back the database as it was before this deploy's migrations (the newest pre-migration copy the new app took after
# the deploy began), so the previous image never runs on a schema it does not know.
restore_pre_migration() {
  local tag="$1"
  if (( SPLIT )); then IMAGE_TAG="$tag" docker compose stop "${ROLES[@]}" || true; else IMAGE_TAG="$tag" docker compose stop app || true; fi
  if (( POSTGRES )); then
    backup_run "$tag" restore-pre-migration
    return
  fi
  app_run "$tag" --entrypoint sh app -c 'set -e
    f=$(ls -1 /data/backups/pre-migration-*.db 2>/dev/null | sort | tail -1)
    [ -n "$f" ] && [ "$f" -nt /data/.deploy-started ] || { echo "[deploy] no pre-migration copy from this deploy" >&2; exit 1; }
    cp "$f" /data/job-agent.db.restoring
    rm -f /data/job-agent.db-wal /data/job-agent.db-shm
    mv /data/job-agent.db.restoring /data/job-agent.db
    echo "[deploy] database put back from $f"'
}

# Starts a tag. The split layout: every role on the tag (or, keep_tags=1, each on its own recorded tag), the one app
# container removed, the roles and the demo first, then the api and Caddy.
start_tag() {
  local tag="$1" keep_tags="${2:-0}"
  log "Starting image $tag"
  if (( SPLIT )); then
    if (( keep_tags )); then load_tags; else clear_tags; fi
    compose "$tag" pull "${SERVICES[@]}"
    compose "$tag" rm -sf app
    compose "$tag" up -d --remove-orphans worker-browser worker-ai worker-io scheduler demo backup
    compose "$tag" up -d api caddy
  else
    compose "$tag" pull "${SERVICES[@]}"
    compose "$tag" up -d --remove-orphans
  fi
  healthy
}

# The split layout: replaces the named services with a tag, the others untouched. Returns non-zero if one is unhealthy.
start_only() {
  local tag="$1"; shift
  load_tags
  local r
  for r in "$@"; do export "$(tag_var "$r")=$tag"; done
  log "Starting $* on $tag"
  compose "${IMAGE_TAG_BASE:-$tag}" pull "$@"
  compose "${IMAGE_TAG_BASE:-$tag}" up -d --no-deps "$@"
  healthy "$@"
}

# PostgreSQL: check, back up and migrate before the new image starts. Sets migrating=1 once migrations may have run.
pg_prepare() {
  local check=0
  log "Pulling $TAG and checking whether it changes the database (on a scratch copy)"
  IMAGE_TAG="$TAG" docker compose pull app backup
  app_run "$TAG" --entrypoint sh app -c 'touch /data/.deploy-started'
  backup_run "$TAG" pre-migrate || check=$?
  if (( check == 0 )); then return 0; fi
  (( check == 10 )) || fail "The database check of $TAG failed (a migration failed on the scratch copy). Nothing changed."
  if [[ "$OPTION" == --no-backup ]]; then
    log "Database changes ahead; the Drive backup is skipped (--no-backup); the checked dump is kept"
  else
    [[ -n "$current" ]] || fail "Database changes ahead but no current image to back up with. Run: ./deploy.sh deploy $TAG --no-backup"
    log "Database changes ahead: encrypted Drive backup with $current first"
    backup_run "$current" backup-now || fail "The backup failed, so $TAG was not started and nothing changed."
  fi
  migrating=1
  log "Migrating the database with $TAG"
  # In the backup container: only it holds the owner login (backup.env); the image is this tag's.
  if ! IMAGE_TAG="$TAG" docker compose run --rm --no-deps -T backup node scripts/migrate.js; then
    log "The migration failed; putting the database back"
    restore_pre_migration "$TAG" || fail "Could not put the database back. Check data/backups on the server."
    if [[ -n "$current" ]]; then start_tag "$current" || true; fi
    fail "Deploy of $TAG failed at its migration; the database is back as it was."
  fi
}

# deploy <tag> --only <services>: the split layout, one or more roles alone, never across a schema change.
deploy_only() {
  (( SPLIT )) || fail "--only needs the split layout (server.conf LAYOUT=split)."
  [[ -n "$ONLY" ]] || fail "--only needs the services, e.g. --only worker-browser"
  local list=() r
  IFS=',' read -r -a list <<< "$ONLY"
  for r in "${list[@]}"; do is_role "$r" || fail "Unknown service \"$r\" (one of: ${ROLES[*]})."; done
  [[ -n "$current" ]] || fail "Nothing deployed yet. Run: ./deploy.sh deploy <tag>"
  refresh_env
  same_schema "$TAG" "$current" || fail "$TAG and the running $current know different migrations; deploy every service: ./deploy.sh deploy $TAG"
  local before=()
  for r in "${list[@]}"; do before+=("$(service_tag "$r")"); done
  if IMAGE_TAG_BASE="$current" start_only "$TAG" "${list[@]}"; then
    for r in "${list[@]}"; do set_service_tag "$r" "$TAG"; done
    log "Healthy: ${list[*]} on $TAG"
  else
    log "${list[*]} on $TAG did not pass /healthz within ${HEALTH_WAIT_SECONDS}s; going back"
    docker compose logs --tail 40 "${list[@]}" >&2 || true
    local i
    for i in "${!list[@]}"; do IMAGE_TAG_BASE="$current" start_only "${before[$i]:-$current}" "${list[$i]}" || true; done
    fail "Deploy of ${list[*]} on $TAG failed; they run their previous tags again."
  fi
}

case "$ACTION" in
  deploy)
    valid_tag "$TAG" || fail "deploy needs an image tag (letters, digits, dot, dash, underscore)."
    current="$(cat "$CURRENT_FILE" 2>/dev/null || true)"
    if [[ "$OPTION" == --only ]]; then
      deploy_only
      exit 0
    fi
    migrating=0
    refresh_env
    if (( POSTGRES )) && [[ "$OPTION" != --skip-db-check ]]; then
      pg_prepare
    elif [[ "$OPTION" != --skip-db-check ]]; then
      log "Pulling $TAG and checking whether it changes the database"
      IMAGE_TAG="$TAG" docker compose pull app
      check=0
      db_check "$TAG" || check=$?
      if (( check == 10 )); then
        migrating=1
        if [[ "$OPTION" == --no-backup ]]; then
          log "Database changes ahead; the Drive backup is skipped (--no-backup)"
        else
          [[ -n "$current" ]] || fail "Database changes ahead but no current image to back up with. Run: ./deploy.sh deploy $TAG --no-backup"
          log "Database changes ahead: encrypted backup with $current first"
          app_run "$current" app node scripts/backup.js || fail "The backup failed, so $TAG was not started and nothing changed."
        fi
        app_run "$TAG" --entrypoint sh app -c 'touch /data/.deploy-started'
      elif (( check != 0 )); then
        fail "The database check of $TAG failed (a migration failed on a copy, or the image has no check: use --skip-db-check for an old tag). Nothing changed."
      fi
    fi
    if start_tag "$TAG"; then
      if [[ -n "$current" && "$current" != "$TAG" ]]; then echo "$current" > "$PREVIOUS_FILE"; fi
      echo "$TAG" > "$CURRENT_FILE"
      if (( SPLIT )); then for r in "${ROLES[@]}"; do set_service_tag "$r" "$TAG"; done; fi
      log "Healthy on $TAG"
      # Keep disk use in check: remove every image no container uses (a deploy a day of 1 GB images fills the disk in
      # weeks). A rollback pulls the previous image again from the registry.
      docker image prune -af >/dev/null 2>&1 || true
    else
      log "Image $TAG did not pass /healthz within ${HEALTH_WAIT_SECONDS}s"
      docker compose logs --tail 40 "${SERVICES[@]}" >&2 || true
      if [[ -n "$current" ]]; then
        if (( migrating )); then restore_pre_migration "$TAG" || fail "Could not put the database back; $current not started. Check data/backups on the server."; fi
        log "Going back to $current"
        start_tag "$current" 1 || fail "The previous image $current is not healthy either. Check: docker compose logs app"
        fail "Deploy of $TAG failed; running $current again."
      fi
      fail "Deploy of $TAG failed and there is no earlier image to go back to."
    fi
    ;;
  rollback)
    current="$(cat "$CURRENT_FILE" 2>/dev/null || true)"
    if [[ -n "$TAG" ]]; then
      # rollback <service>: the split layout, that service alone.
      (( SPLIT )) || fail "rollback <service> needs the split layout (server.conf LAYOUT=split)."
      [[ -z "$OPTION" ]] || fail "Too many arguments."
      is_role "$TAG" || fail "Unknown service \"$TAG\" (one of: ${ROLES[*]})."
      service="$TAG"
      previous="$(cat "$STATE_DIR/.prev-tag-$service" 2>/dev/null || true)"
      [[ -n "$previous" ]] || fail "No previous tag recorded for $service."
      now="$(service_tag "$service")"
      refresh_env
      same_schema "$previous" "${now:-$current}" || fail "$previous knows different migrations from the running ${now:-$current}; roll back every service: ./deploy.sh rollback"
      IMAGE_TAG_BASE="$current" start_only "$previous" "$service" || fail "$service on $previous is not healthy. Check: docker compose logs $service"
      set_service_tag "$service" "$previous"
      log "Rolled $service back to $previous"
      exit 0
    fi
    previous="$(cat "$PREVIOUS_FILE" 2>/dev/null || true)"
    [[ -n "$previous" ]] || fail "No previous image recorded."
    refresh_env
    start_tag "$previous" || fail "Image $previous is not healthy. Check: docker compose logs app"
    echo "$previous" > "$CURRENT_FILE"
    [[ -n "$current" ]] && echo "$current" > "$PREVIOUS_FILE"
    if (( SPLIT )); then for r in "${ROLES[@]}"; do set_service_tag "$r" "$previous"; done; fi
    log "Rolled back to $previous"
    ;;
  up)
    [[ -z "$TAG" ]] || fail "up takes no arguments."
    current="$(cat "$CURRENT_FILE" 2>/dev/null || true)"
    [[ -n "$current" ]] || fail "Nothing deployed yet. Run: ./deploy.sh deploy <tag>"
    refresh_env
    start_tag "$current" 1 || fail "Image $current is not healthy. Check: docker compose logs"
    log "Running $current"
    ;;
  status)
    echo "deployed: $(cat "$CURRENT_FILE" 2>/dev/null || echo none)"
    echo "previous: $(cat "$PREVIOUS_FILE" 2>/dev/null || echo none)"
    if (( SPLIT )); then
      for r in "${ROLES[@]}"; do echo "$r: $(service_tag "$r" | grep . || cat "$CURRENT_FILE" 2>/dev/null || echo none)"; done
    fi
    docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
    ;;
  *)
    fail "Unknown action \"$ACTION\". Use deploy <tag> [--no-backup|--skip-db-check|--only <services>], rollback [<service>], up, or status."
    ;;
esac
