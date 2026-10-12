#!/bin/bash
# soulseek-addon share gate (immediate mode).
# Finished downloads move to the archive dir as soon as they look settled
# (idle reads+writes past SHARE_DELAY_HOURS, default 0 = ~1 minute).
# Growing files and slskd's incomplete/ area never move. Playback is
# unaffected: the addon serves staging instantly; the gate only decides
# what gets a durable second copy.
# Env: STAGING_DIR (slskd downloads), SHARED_DIR (archive target),
# SHARE_DELAY_HOURS (default 0). Logs to /var/log/soulseek-prune.log.
STAGING=${STAGING_DIR:-/var/lib/docker/volumes/soulseek-addon_downloads/_data}
SHARED=${SHARED_DIR:-/var/lib/docker/volumes/soulseek-addon_shared/_data}
DELAY_HOURS=${SHARE_DELAY_HOURS:-0}
[ -d "$STAGING" ] || exit 0
mkdir -p "$SHARED"
# Kill-switch: with the TeraBox tier disabled, a terabox destination is a
# no-op (files stay in staging for the normal prune lifecycle).
if [ "${TERABOX_ENABLED:-1}" = "0" ]; then
  case "$SHARED" in
    /terabox*)
      echo "=== $(date -u +%FT%TZ) share-gate parked (TERABOX_ENABLED=0) ==="
      exit 0
      ;;
  esac
fi

DELAY_MIN=$((DELAY_HOURS * 60))
# find's +0 matches nearly everything (minute granularity), so floor the
# threshold at 1: delay 0 still means "settled for ~a minute", never "now".
GATE_MIN=$((DELAY_MIN > 0 ? DELAY_MIN : 1))
moved=0
# Never touch slskd's in-progress area: only promote finished files.
find "$STAGING" -type f -amin +"$GATE_MIN" -mmin +"$GATE_MIN" -print0 2>/dev/null |
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
# prune empty staging dirs left behind (never slskd's incomplete/ itself:
# empty is normal, and slskd refuses to start when it's missing)
find "$STAGING" -mindepth 1 -type d -empty ! -path "$STAGING/incomplete" ! -path "$STAGING/incomplete/*" -delete 2>/dev/null
echo "=== $(date -u +%FT%TZ) share-gate end (delay: ${DELAY_HOURS}h) ==="
