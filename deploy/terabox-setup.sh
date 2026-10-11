#!/bin/sh
# Install rclone-extra (rclone fork with TeraBox backend) + configure the
# terabox remote. Needs your TeraBox ndus cookie:
#   terabox.com -> login -> F12 -> Application -> Cookies -> copy `ndus`
# Usage: NDUS='<cookie>' ./deploy/terabox-setup.sh
set -e
BIN=/usr/local/bin/rclone
if ! "$BIN" version >/dev/null 2>&1; then
  echo "installing rclone-extra..."
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64) RARCH=amd64 ;; aarch64) RARCH=arm64 ;; *) echo "unsupported arch $ARCH"; exit 1 ;;
  esac
  URL=$(curl -s https://api.github.com/repos/gulp79/rclone-extra/releases/latest \
    | grep -oE "https://[^\" ]*linux-${RARCH}[^\" ]*\\.zip" | head -1)
  [ -n "$URL" ] || { echo "could not find release asset"; exit 1; }
  curl -sL -o /tmp/rclone-extra.zip "$URL"
  python3 -c "import zipfile,shutil,glob; z=zipfile.ZipFile('/tmp/rclone-extra.zip'); n=[x for x in z.namelist() if x.endswith('/rclone')][0]; z.extract(n,'/tmp/rb'); shutil.move('/tmp/rb/'+n,'$BIN')"
  chmod +x "$BIN"
  rm -rf /tmp/rclone-extra.zip /tmp/rb
fi
"$BIN" version | head -1

if [ -z "$NDUS" ]; then
  echo "set NDUS='<your ndus cookie>' and re-run to configure the remote"
  exit 0
fi
mkdir -p /root/.config/rclone /terabox
cat > /root/.config/rclone/rclone.conf <<EOF
[terabox]
type = terabox
cookie = $NDUS
EOF
chmod 600 /root/.config/rclone/rclone.conf
"$BIN" --config /root/.config/rclone/rclone.conf about terabox: 2>&1 | head -3
echo "remote configured. start the mount with:"
echo "  cp deploy/rclone-terabox-mount.service /etc/systemd/system/ && systemctl enable --now rclone-terabox-mount"
