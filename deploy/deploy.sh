#!/usr/bin/env bash
# Deploys, rolls back, or reports the Job Agent app on the cloud server. Lives at /opt/job-agent/deploy.sh.
#
#   ./deploy.sh deploy <image tag>   pull that image, start it, wait for /healthz; on failure, go back to the last good one
#   ./deploy.sh rollback             start the previous good image again
#   ./deploy.sh up                   start the current good image (after a reboot or a .env change)
#   ./deploy.sh status               the running tag and container health
#
# GitHub Actions reaches this script through a deploy key whose authorized_keys line forces this command, so the key
# can run nothing else: command="/opt/job-agent/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty
# In that case the requested words arrive in SSH_ORIGINAL_COMMAND and are checked below before anything runs.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"
CURRENT_FILE=.deployed-tag
PREVIOUS_FILE=.previous-tag
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
[[ ${#ARGS[@]} -le 2 ]] || fail "Too many arguments."

valid_tag() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; }

# One deploy at a time, even if two pushes land close together.
exec 9> .deploy.lock
flock -w 600 9 || fail "Another deploy is still running."

compose() { IMAGE_TAG="$1" docker compose "${@:2}"; }

healthy() {
  local waited=0
  while (( waited < HEALTH_WAIT_SECONDS )); do
    if docker compose exec -T app node -e "fetch('http://127.0.0.1:5178/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
    waited=$(( waited + 3 ))
  done
  return 1
}

start_tag() {
  local tag="$1"
  log "Starting image $tag"
  compose "$tag" pull app
  compose "$tag" up -d --remove-orphans
  healthy
}

case "$ACTION" in
  deploy)
    valid_tag "$TAG" || fail "deploy needs an image tag (letters, digits, dot, dash, underscore)."
    current="$(cat "$CURRENT_FILE" 2>/dev/null || true)"
    if start_tag "$TAG"; then
      if [[ -n "$current" && "$current" != "$TAG" ]]; then echo "$current" > "$PREVIOUS_FILE"; fi
      echo "$TAG" > "$CURRENT_FILE"
      log "Healthy on $TAG"
      # Keep disk use in check: remove images no container uses that are over a week old.
      docker image prune -af --filter "until=168h" >/dev/null 2>&1 || true
    else
      log "Image $TAG did not pass /healthz within ${HEALTH_WAIT_SECONDS}s"
      docker compose logs --tail 40 app >&2 || true
      if [[ -n "$current" ]]; then
        log "Going back to $current"
        start_tag "$current" || fail "The previous image $current is not healthy either. Check: docker compose logs app"
        fail "Deploy of $TAG failed; running $current again."
      fi
      fail "Deploy of $TAG failed and there is no earlier image to go back to."
    fi
    ;;
  rollback)
    previous="$(cat "$PREVIOUS_FILE" 2>/dev/null || true)"
    [[ -n "$previous" ]] || fail "No previous image recorded."
    current="$(cat "$CURRENT_FILE" 2>/dev/null || true)"
    start_tag "$previous" || fail "Image $previous is not healthy. Check: docker compose logs app"
    echo "$previous" > "$CURRENT_FILE"
    [[ -n "$current" ]] && echo "$current" > "$PREVIOUS_FILE"
    log "Rolled back to $previous"
    ;;
  up)
    current="$(cat "$CURRENT_FILE" 2>/dev/null || true)"
    [[ -n "$current" ]] || fail "Nothing deployed yet. Run: ./deploy.sh deploy <tag>"
    start_tag "$current" || fail "Image $current is not healthy. Check: docker compose logs app"
    log "Running $current"
    ;;
  status)
    echo "deployed: $(cat "$CURRENT_FILE" 2>/dev/null || echo none)"
    echo "previous: $(cat "$PREVIOUS_FILE" 2>/dev/null || echo none)"
    docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
    ;;
  *)
    fail "Unknown action \"$ACTION\". Use deploy <tag>, rollback, up, or status."
    ;;
esac
