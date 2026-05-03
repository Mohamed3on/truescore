#!/usr/bin/env bash
# Run on a fresh Hetzner Ubuntu 24.04 box AS ROOT.
#   curl -fsSL <url-or-paste> | bash
# Idempotent — safe to re-run.
set -euo pipefail

USER_NAME="truescore"
APP_DIR="/opt/truescore"
STATE_DIR="/var/lib/truescore"
CACHE_PATH="$STATE_DIR/cache.json"
COOKIES_PATH="$STATE_DIR/cookies.json"

echo ">> apt update + base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg unzip rsync

echo ">> Bun (system-wide for the truescore user)"
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.8"
  install -m 755 ~/.bun/bin/bun /usr/local/bin/bun
fi

echo ">> cloudflared"
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | tee /etc/apt/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/etc/apt/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq
  apt-get install -y -qq cloudflared
fi

echo ">> service user + dirs"
id -u "$USER_NAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "$USER_NAME"
mkdir -p "$APP_DIR" "$STATE_DIR"
chown -R "$USER_NAME:$USER_NAME" "$APP_DIR" "$STATE_DIR"

echo ">> systemd unit: truescore.service"
cat > /etc/systemd/system/truescore.service <<EOF
[Unit]
Description=TrueScore web server (Bun, RPC-only via residential proxy)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=TRUESCORE_CACHE_PATH=$CACHE_PATH
Environment=TRUESCORE_COOKIES_PATH=$COOKIES_PATH
Environment=HOME=/home/$USER_NAME
ExecStart=/usr/local/bin/bun server.ts
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

echo ">> systemd unit: truescore-tunnel.service"
cat > /etc/systemd/system/truescore-tunnel.service <<EOF
[Unit]
Description=Cloudflare Tunnel for TrueScore
After=truescore.service
Requires=truescore.service

[Service]
Type=simple
User=$USER_NAME
ExecStart=/usr/bin/cloudflared tunnel --url http://localhost:3000 --metrics localhost:0
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

echo ""
echo "=========================================="
echo "Server prep done."
echo ""
echo "Next steps from your laptop:"
echo "  1. Sync code + cookies (run deploy/sync.sh)"
echo "  2. Start services: ssh root@<ip> systemctl enable --now truescore truescore-tunnel"
echo "  3. Get tunnel URL: ssh root@<ip> journalctl -u truescore-tunnel -n 50 --no-pager | grep trycloudflare"
echo "=========================================="
