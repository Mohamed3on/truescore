#!/usr/bin/env bash
# Sync code to the Hetzner box. Run from the truescore-web repo root.
#   SERVER=root@65.108.153.112 ./deploy/sync.sh
# .env is excluded — each environment owns its own. Cookies are baked by the
# server itself via the proxy on first request, so no profile/cookie sync either.
set -euo pipefail

: "${SERVER:?set SERVER=root@<ip>}"
APP_DIR="/opt/truescore"
STATE_DIR="/var/lib/truescore"

echo ">> code"
rsync -avz --delete \
  --exclude node_modules \
  --exclude '*.log' \
  --exclude .git \
  --exclude deploy \
  --exclude .env \
  ./ "$SERVER:$APP_DIR/"

echo ">> bun install on the server"
ssh "$SERVER" "cd $APP_DIR && /usr/local/bin/bun install"

echo ">> fix ownership"
ssh "$SERVER" "chown -R truescore:truescore $APP_DIR $STATE_DIR"

echo ">> restart"
ssh "$SERVER" 'systemctl restart truescore'
echo "Done."
