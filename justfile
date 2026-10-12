# soulseek-addon — recurring workflows.
# Run `just` (no args) to list everything.
# VPS recipes ssh as root. Configure YOUR host via env (never committed):
#   export VPS_HOST=<your-server-ip> VPS_SSH_USER=root ADDON_URL=https://<your-host>

vps_host := env("VPS_HOST", "")
vps_user := env("VPS_SSH_USER", "root")
vps := vps_user + "@" + vps_host
addon := env("ADDON_URL", "")

default:
    @just --list

# ── local dev ────────────────────────────────────────────────────────────────

# Run the addon locally (http://localhost:3000, mock unless .env set).
dev:
    node src/server.js

# Run the test suite.
test:
    npm test

# Syntax-check all sources.
check:
    node --check src/server.js && node --check src/slskd.js && node --check src/audio.js && node --check src/terabox.js && sh -n deploy/prune.sh && sh -n deploy/share-gate.sh && sh -n deploy/prune-monitor.sh && echo OK

# ── VPS (set VPS_HOST + ADDON_URL, see top) ────────────────────────────────────

# Container + service states.
vps-status:
    #!/usr/bin/env bash
    set -euo pipefail
    [ -n "{{vps_host}}" ] || { echo "set VPS_HOST first (see justfile top)"; exit 1; }
    ssh -o BatchMode=yes {{vps}} 'docker ps | grep -E "slskd|soulseek|caddy|NAMES"; df -h / | tail -1; free -m | head -2 | tail -1'

# SoulSeek login + distributed mesh state.
vps-slskd:
    #!/usr/bin/env bash
    set -euo pipefail
    ssh -o BatchMode=yes {{vps}} 'python3 -c "
    import json,urllib.request
    key=[l.split(\"=\",1)[1].strip() for l in open(\"/root/soulseek-addon/.env\") if l.startswith(\"SLSKD_API_KEY=\")][0]
    d=json.load(urllib.request.urlopen(urllib.request.Request(\"http://localhost:5030/api/v0/application\",headers={\"X-API-Key\":key}),timeout=20))
    print(\"server:\",d[\"server\"][\"state\"],\"| parent:\",d[\"distributedNetwork\"][\"hasParent\"])"'

# Addon health via public HTTPS.
vps-health:
    @curl -s --max-time 15 {{addon}}/manifest.json -o /dev/null -w 'manifest:%{http_code}\n'

# Search the live addon (usage: just vps-search "Grand Escape").
vps-search query:
    #!/usr/bin/env bash
    set -euo pipefail
    Q=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' {{quote(query)}})
    curl -s --max-time 100 "{{addon}}/search?q=$Q" | python3 -c "import json,sys; [print(t.get('format'),t.get('audioQuality'),'|',t['artist'],'-',t['title'][:60]) for t in json.load(sys.stdin)['tracks'][:10]]"

# Follow addon + slskd logs.
vps-logs:
    #!/usr/bin/env bash
    set -euo pipefail
    ssh -o BatchMode=yes {{vps}} 'docker logs --tail 20 soulseek-addon; echo ===; docker logs --tail 5 slskd'

# Ship current src to the VPS and restart the addon.
vps-deploy:
    #!/usr/bin/env bash
    set -euo pipefail
    tar czf /tmp/soulseek-addon.tar.gz src package.json
    scp -o StrictHostKeyChecking=no /tmp/soulseek-addon.tar.gz {{vps}}:/root/addon.tar.gz
    ssh -o StrictHostKeyChecking=no {{vps}} 'tar xzf /root/addon.tar.gz -C /root/soulseek-addon && docker restart soulseek-addon && sleep 5 && curl -s --max-time 10 {{addon}}/manifest.json -o /dev/null -w "manifest:%{http_code}\n"'
    rm -f /tmp/soulseek-addon.tar.gz

# Run the origin prune now.
vps-prune:
    #!/usr/bin/env bash
    set -euo pipefail
    ssh -o BatchMode=yes {{vps}} '/root/soulseek-addon/prune.sh | tail -2; df -h / | tail -1'

# Disk + cache sizes.
vps-disk:
    #!/usr/bin/env bash
    set -euo pipefail
    ssh -o BatchMode=yes {{vps}} 'du -sh /var/lib/docker/volumes/soulseek-addon_downloads/_data; df -h / | tail -1; tail -1 /var/log/soulseek-prune.log'
