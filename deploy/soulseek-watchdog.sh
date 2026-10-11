#!/bin/sh
# soulseek watchdog: keeps slskd logged in and the addon answering.
# Every CHECK_SECS: slskd /health, slskd login state (API), addon /health.
# On failure: log + `docker restart` (at most once per COOLDOWN_SECS per
# service, so a truly dead dependency doesn't spin). Logs to
# /var/log/soulseek-watchdog.log. Run via soulseek-watchdog.service.
CHECK_SECS=${CHECK_SECS:-60}
COOLDOWN_SECS=${COOLDOWN_SECS:-300}
STATEDIR=${STATE_DIR:-/tmp}
API_KEY=$(grep SLSKD_API_KEY /root/soulseek-addon/.env 2>/dev/null | cut -d= -f2-)

mark() { date -u +%s > "$STATEDIR/soulseek-watchdog-$1"; }
cooled_down() {
  last=$(cat "$STATEDIR/soulseek-watchdog-$1" 2>/dev/null || echo 0)
  [ $(( $(date +%s) - last )) -ge "$COOLDOWN_SECS" ]
}
restart() {
  echo "=== $(date -u +%FT%TZ) watchdog: restarting $1 ($2) ==="
  docker restart "$1" >/dev/null 2>&1
  mark "$1"
}

while true; do
  # 1. slskd process health (no auth needed).
  if ! curl -s --max-time 10 -o /dev/null -w "%{http_code}" http://localhost:5030/health 2>/dev/null | grep -q 200; then
    echo "=== $(date -u +%FT%TZ) watchdog: slskd /health failing ==="
    if cooled_down slskd; then restart slskd "unhealthy"; fi
  else
    # 2. SoulSeek login state (only meaningful when the API answers).
    state=$(curl -s --max-time 15 -H "X-API-Key: $API_KEY" http://localhost:5030/api/v0/application 2>/dev/null \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['server']['state'])" 2>/dev/null)
    if [ -n "$state" ] && [ "$state" != "Connected, LoggedIn" ]; then
      echo "=== $(date -u +%FT%TZ) watchdog: soulseek state=$state ==="
      # Login lapses auto-recover inside slskd; restart only if stuck >10min.
      # (Tracked by marker file: first sighting starts the clock.)
      if [ -f "$STATEDIR/soulseek-watchdog-dropped" ]; then
        since=$(($(date +%s) - $(cat "$STATEDIR/soulseek-watchdog-dropped")))
        if [ "$since" -gt 600 ] && cooled_down slskd-stuck; then
          restart slskd "login stuck 10min+ ($state)"
          rm -f "$STATEDIR/soulseek-watchdog-dropped"
        fi
      else
        date +%s > "$STATEDIR/soulseek-watchdog-dropped"
      fi
    else
      rm -f "$STATEDIR/soulseek-watchdog-dropped"
    fi
  fi
  # 3. addon health (local, no token needed).
  if ! curl -s --max-time 10 -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/health 2>/dev/null | grep -q 200; then
    echo "=== $(date -u +%FT%TZ) watchdog: addon /health failing ==="
    if cooled_down soulseek-addon; then restart soulseek-addon "unhealthy"; fi
  fi
  sleep "$CHECK_SECS"
done
