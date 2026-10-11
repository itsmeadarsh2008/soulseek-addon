#!/bin/sh
# slskd connection watchdog: restarts the container when SoulSeek stays
# disconnected. slskd auto-reconnects in seconds from transient drops; this
# covers WEDGED states (API up but searches 500/timeout for minutes).
# Env: SLSKD_URL (default http://localhost:5030), SLSKD_API_KEY (required),
# MAX_FAILS (consecutive bad checks before restart, default 2).
# State in /tmp (a reboot clears the counter). Logs to stdout (journal).
URL=${SLSKD_URL:-http://localhost:5030}
STATE_FILE=/tmp/slskd-watchdog-fails
MAX_FAILS=${MAX_FAILS:-2}

ok=0
if [ -n "$SLSKD_API_KEY" ]; then
  state=$(curl -s --max-time 15 -H "X-API-Key: $SLSKD_API_KEY" "$URL/api/v0/application" 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['server']['state'])" 2>/dev/null)
  case "$state" in
    Connected*|*LoggedIn*) ok=1 ;;
  esac
fi

if [ "$ok" = "1" ]; then
  rm -f "$STATE_FILE"
  echo "slskd connected"
  exit 0
fi

fails=$(($(cat "$STATE_FILE" 2>/dev/null || echo 0) + 1))
echo "$fails" > "$STATE_FILE"
echo "slskd not connected (check $fails/$MAX_FAILS)"
if [ "$fails" -ge "$MAX_FAILS" ]; then
  echo "restarting slskd container"
  docker restart slskd
  rm -f "$STATE_FILE"
fi
