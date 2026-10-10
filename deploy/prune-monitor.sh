#!/bin/sh
# soulseek-addon disk-pressure monitor: runs prune.sh ONCE each time disk
# usage hits DISK_MAX_PCT, then stays quiet until the next crossing.
# No schedule — cleanup is purely event-driven (edge-triggered with hysteresis:
# re-arms only after usage drops 5 points below threshold, so one fill-up
# triggers exactly one prune run, not a loop).
# Env (via prune.env): DISK_MAX_PCT (default 80), MOUNT (default /),
# CHECK_SECS (default 60).
MOUNT=${MOUNT:-/}
DISK_MAX_PCT=${DISK_MAX_PCT:-80}
CHECK_SECS=${CHECK_SECS:-60}
SCRIPT_DIR=$(dirname "$0")

usage() {
  df "$MOUNT" | tail -1 | awk '{print $5}' | tr -d '%'
}

armed=1
while true; do
  u=$(usage)
  if [ "$armed" -eq 1 ] && [ "$u" -ge "$DISK_MAX_PCT" ]; then
    echo "=== $(date -u +%FT%TZ) disk hit ${u}% (>= ${DISK_MAX_PCT}%), pruning once ==="
    "$SCRIPT_DIR/prune.sh"
    armed=0
  elif [ "$armed" -eq 0 ] && [ "$u" -lt $((DISK_MAX_PCT - 5)) ]; then
    echo "=== $(date -u +%FT%TZ) disk back to ${u}%, re-arming ==="
    armed=1
  fi
  sleep "$CHECK_SECS"
done
