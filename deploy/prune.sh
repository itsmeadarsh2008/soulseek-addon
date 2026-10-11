#!/bin/sh
# soulseek-addon origin cache prune: TTL + size safety cap.
# Deletes only files neither READ nor WRITTEN in the last TTL window
# (active downloads always have a fresh mtime, so they're safe).
# With edge caching on, keep TTL short (6-12h): repeats come from the edge,
# origin just refetches from SoulSeek on edge miss. Without edge caching,
# keep 24-48h so replays don't stall on peer downloads.
# Env: TTL_HOURS (default 48), MAX_MB (default 4096), DISK_MAX_PCT (default 80),
# DATA_DIR (staging volume path), SHARED_DIR (stable share volume, optional),
# SHARED_TTL_HOURS (default 720), SHARED_MAX_MB (default 6144),
# MOUNT (filesystem to watch, default /), SKIP_STAGING (default 0: when 1,
# only the shared/archive dir is pruned — used by the monthly TeraBox swipe).
# Keep TTL_HOURS > SHARE_DELAY_HOURS or the gate never sees a file.
# Runs hourly via soulseek-prune.timer. Logs to /var/log/soulseek-prune.log.
D=${DATA_DIR:-/var/lib/docker/volumes/soulseek-addon_downloads/_data}
MOUNT=${MOUNT:-/}
TTL_HOURS=${TTL_HOURS:-48}
MAX_MB=${MAX_MB:-4096}
DISK_MAX_PCT=${DISK_MAX_PCT:-80}
SHARED=${SHARED_DIR:-}
SHARED_TTL_HOURS=${SHARED_TTL_HOURS:-720}
SHARED_MAX_MB=${SHARED_MAX_MB:-6144}
[ -d "$D" ] || exit 0

prune_dir() {
  dir=$1; ttl_h=$2; cap_mb=$3; label=$4
  [ -d "$dir" ] || return 0
  # Floor at 1: find's +0 matches nearly everything (minute granularity).
  ttl_min=$((ttl_h * 60)); [ "$ttl_min" -lt 1 ] && ttl_min=1
  echo "--- $label start (du: $(du -sh "$dir" | cut -f1), ttl: ${ttl_h}h, cap: ${cap_mb}M) ---"
  find "$dir" -type f -amin +"$ttl_min" -mmin +"$ttl_min" -print -delete
  while [ "$(du -sm "$dir" | cut -f1)" -gt "$cap_mb" ]; do
    victim=$(find "$dir" -type f -printf '%A@ %p\n' 2>/dev/null | sort -n | head -1 | cut -d' ' -f2-)
    [ -n "$victim" ] || break
    echo "evict [$label]: $victim"
    rm -f "$victim"
  done
  find "$dir" -mindepth 1 -type d -empty -delete 2>/dev/null
  echo "--- $label end (du: $(du -sh "$dir" | cut -f1)) ---"
}

echo "=== $(date -u +%FT%TZ) prune start (disk: $(df "$MOUNT" | tail -1 | awk '{print $5}')) ==="
if [ "${SKIP_STAGING:-0}" != "1" ]; then
  prune_dir "$D" "$TTL_HOURS" "$MAX_MB" staging
else
  echo "--- staging skipped (SKIP_STAGING=1) ---"
fi
if [ -n "$SHARED" ]; then
  prune_dir "$SHARED" "$SHARED_TTL_HOURS" "$SHARED_MAX_MB" shared
fi

evict_oldest() {
  victim=$(find "$D" ${SHARED:+$SHARED} -type f -printf '%A@ %p\n' 2>/dev/null | sort -n | head -1 | cut -d' ' -f2-)
  [ -n "$victim" ] || return 1
  echo "evict: $victim"
  rm -f "$victim"
}

# disk pressure: once the disk fills past DISK_MAX_PCT, delete local
# cache oldest-played-first until back under budget (age ignored).
while [ "$(df "$MOUNT" | tail -1 | awk '{print $5}' | tr -d '%')" -ge "$DISK_MAX_PCT" ]; do
  echo "disk pressure: $(df "$MOUNT" | tail -1 | awk '{print $5}') used, evicting cache"
  evict_oldest || break
done

echo "=== prune end (disk: $(df "$MOUNT" | tail -1 | awk '{print $5}')) ==="
