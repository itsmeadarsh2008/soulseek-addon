#!/bin/sh
# soulseek-addon share stopper (quarantine gate).
# New downloads sit UNSHARED in staging until they've aged past SHARE_DELAY_HOURS
# with no reads or writes — only then are they moved to the stable share dir
# where slskd publishes them to the network. Playback is unaffected: the addon
# serves from staging immediately; this gate only controls SoulSeek sharing.
# Env: STAGING_DIR (slskd downloads), SHARED_DIR (slskd shares),
# SHARE_DELAY_HOURS (default 24). Logs to /var/log/soulseek-prune.log.
STAGING=${STAGING_DIR:-/var/lib/docker/volumes/soulseek-addon_downloads/_data}
SHARED=${SHARED_DIR:-/var/lib/docker/volumes/soulseek-addon_shared-data/_data}
DELAY_HOURS=${SHARE_DELAY_HOURS:-24}
[ -d "$STAGING" ] || exit 0
mkdir -p "$SHARED"

DELAY_MIN=$((DELAY_HOURS * 60))
moved=0
# Never touch slskd's in-progress area: only promote finished files.
find "$STAGING" -type f -amin +"$DELAY_MIN" -mmin +"$DELAY_MIN" -print0 2>/dev/null |
  while IFS= read -r -d '' f; do
    case "$f" in
      "$STAGING"/incomplete/*) continue ;;
    esac
    rel=${f#"$STAGING"/}
    dest="$SHARED/$rel"
    mkdir -p "$(dirname "$dest")"
    # Skip while the file is still growing (paranoia alongside mtime check).
    s1=$(stat -c %s "$f" 2>/dev/null); sleep 2; s2=$(stat -c %s "$f" 2>/dev/null)
    [ "$s1" = "$s2" ] || continue
    if mv -n "$f" "$dest" 2>/dev/null; then
      echo "share-gate: $rel"
      moved=$((moved + 1))
    fi
  done
# prune empty staging dirs left behind
find "$STAGING" -mindepth 1 -type d -empty -delete 2>/dev/null
echo "=== $(date -u +%FT%TZ) share-gate end (delay: ${DELAY_HOURS}h) ==="
