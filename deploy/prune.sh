#!/bin/sh
# soulseek-addon origin cache prune: TTL + size safety cap.
# Deletes only files neither READ nor WRITTEN in the last TTL window
# (active downloads always have a fresh mtime, so they're safe).
# With edge caching on, keep TTL short (6-12h): repeats come from the edge,
# origin just refetches from SoulSeek on edge miss. Without edge caching,
# keep 24-48h so replays don't stall on peer downloads.
# Env: TTL_HOURS (default 48), MAX_MB (default 4096), DISK_MAX_PCT (default 80),
# DATA_DIR (volume path), MOUNT (filesystem to watch, default /).
# Runs hourly via soulseek-prune.timer. Logs to /var/log/soulseek-prune.log.
D=${DATA_DIR:-/var/lib/docker/volumes/soulseek-addon_downloads/_data}
MOUNT=${MOUNT:-/}
TTL_HOURS=${TTL_HOURS:-48}
MAX_MB=${MAX_MB:-4096}
DISK_MAX_PCT=${DISK_MAX_PCT:-80}
[ -d "$D" ] || exit 0

TTL_MIN=$((TTL_HOURS * 60))
echo "=== $(date -u +%FT%TZ) prune start (du: $(du -sh "$D" | cut -f1), disk: $(df "$MOUNT" | tail -1 | awk '{print $5}'), ttl: ${TTL_HOURS}h, cap: ${MAX_MB}M) ==="

# 1. TTL on stale files
find "$D" -type f -amin +"$TTL_MIN" -mmin +"$TTL_MIN" -print -delete

evict_oldest() {
  victim=$(find "$D" -type f -printf '%A@ %p\n' 2>/dev/null | sort -n | head -1 | cut -d' ' -f2-)
  [ -n "$victim" ] || return 1
  echo "evict: $victim"
  rm -f "$victim"
}

# 2. size cap: delete oldest-accessed first while over budget
while [ "$(du -sm "$D" | cut -f1)" -gt "$MAX_MB" ]; do
  evict_oldest || break
done

# 3. disk pressure: once the disk fills past DISK_MAX_PCT, delete local
# cache oldest-played-first until back under budget (age ignored).
while [ "$(df "$MOUNT" | tail -1 | awk '{print $5}' | tr -d '%')" -ge "$DISK_MAX_PCT" ]; do
  echo "disk pressure: $(df "$MOUNT" | tail -1 | awk '{print $5}') used, evicting cache"
  evict_oldest || break
done

# 4. drop empty album dirs
find "$D" -mindepth 1 -type d -empty -delete

echo "=== prune end (du: $(du -sh "$D" | cut -f1), disk: $(df "$MOUNT" | tail -1 | awk '{print $5}')) ==="
