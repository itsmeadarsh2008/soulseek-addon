#!/bin/sh
# soulseek-addon disk-pressure monitor: runs prune.sh whenever disk usage is
# at or above DISK_MAX_PCT. No disarm memory — every crossing triggers a run,
# guarded by flock so slow runs never overlap. Cheap `df` check every 60s.
# Env (via prune.env): DISK_MAX_PCT (default 80), MOUNT (default /),
# CHECK_SECS (default 60).
MOUNT=${MOUNT:-/}
DISK_MAX_PCT=${DISK_MAX_PCT:-80}
CHECK_SECS=${CHECK_SECS:-60}
SCRIPT_DIR=$(dirname "$0")

usage() {
  df "$MOUNT" | tail -1 | awk '{print $5}' | tr -d '%'
}

while true; do
  if [ "$(usage)" -ge "$DISK_MAX_PCT" ]; then
    echo "=== $(date -u +%FT%TZ) disk at $(usage)% (>= ${DISK_MAX_PCT}%), pruning ==="
    flock -n /tmp/soulseek-prune.lock "$SCRIPT_DIR/prune.sh" || echo "(prune already running, skipping)"
  fi
  sleep "$CHECK_SECS"
done
