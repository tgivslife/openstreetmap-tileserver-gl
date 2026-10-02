#!/usr/bin/env bash
# Fault run against the compose.s3.yml stack: faults.js keeps a steady request rate while this script pauses MinIO (a
# storage outage) and then sends the tileserver SIGHUP (a config reload), on the schedule faults.js tags phases with.
#
#   docker compose -f ../compose.s3.yml up -d       # from tileserver-gl-dev/, first
#   ./faults.sh                                     # from this folder; needs k6 and docker on the host
#
# Env: MINIO_CONTAINER, TILESERVER_CONTAINER (default the compose.s3.yml names), and any faults.js variable
# (PAUSE_AT, PAUSE_FOR, RELOAD_AT, DURATION, RATE, KEY, ...), which k6 reads from the environment.
# Exits with k6's status: non-zero when a threshold failed.
set -euo pipefail
cd "$(dirname "$0")"

MINIO=${MINIO_CONTAINER:-tileserver-s3-minio-1}
TILESERVER=${TILESERVER_CONTAINER:-tileserver-s3-tileserver-gl-1}
export PAUSE_AT=${PAUSE_AT:-30} PAUSE_FOR=${PAUSE_FOR:-20} RELOAD_AT=${RELOAD_AT:-90} DURATION=${DURATION:-150}

if ((RELOAD_AT < PAUSE_AT + PAUSE_FOR)); then
  echo "RELOAD_AT ($RELOAD_AT) must come after the outage ends (PAUSE_AT + PAUSE_FOR = $((PAUSE_AT + PAUSE_FOR)))" >&2
  exit 1
fi
for container in "$MINIO" "$TILESERVER"; do
  if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]]; then
    echo "$container is not running; start the stack with: docker compose -f ../compose.s3.yml up -d" >&2
    exit 1
  fi
done

# Never leave MinIO paused, however this script ends.
trap 'docker unpause "$MINIO" >/dev/null 2>&1 || true' EXIT

log() { echo "[faults.sh $(date +%T)] $*"; }

k6 run faults.js &
k6_pid=$!

sleep "$PAUSE_AT"
log "pausing $MINIO for ${PAUSE_FOR}s"
docker pause "$MINIO" >/dev/null
sleep "$PAUSE_FOR"
docker unpause "$MINIO" >/dev/null
log "resumed $MINIO"

sleep $((RELOAD_AT - PAUSE_AT - PAUSE_FOR))
log "sending SIGHUP to $TILESERVER"
docker kill -s HUP "$TILESERVER" >/dev/null

wait "$k6_pid"
