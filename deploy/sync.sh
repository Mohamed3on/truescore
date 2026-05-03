#!/usr/bin/env bash
# Sync the truescore monorepo to a Hetzner box, install workspace deps, and
# restart the service. Run from the monorepo root:
#   SERVER=root@65.108.153.112 ./deploy/sync.sh
#
# Target layout on the box:
#   /opt/truescore/                  ← monorepo root (this rsync target)
#   /opt/truescore/packages/web/     ← what the systemd unit runs
#   /opt/truescore/.env              ← preserved across syncs (excluded below)
#   /var/lib/truescore/{cache,cookies}.json  ← state, owned by truescore user
set -euo pipefail

: "${SERVER:?set SERVER=root@<ip>}"
APP_DIR="/opt/truescore"
STATE_DIR="/var/lib/truescore"

echo ">> sync"
rsync -avz --delete \
  --exclude node_modules \
  --exclude '*.log' \
  --exclude .git \
  --exclude .env \
  --exclude .DS_Store \
  --exclude /packages/extension/truescore \
  --exclude /.github \
  ./ "$SERVER:$APP_DIR/"

echo ">> bun install (workspaces)"
ssh "$SERVER" "cd $APP_DIR && /usr/local/bin/bun install --production"

echo ">> fix ownership"
ssh "$SERVER" "chown -R truescore:truescore $APP_DIR $STATE_DIR"

echo ">> restart"
ssh "$SERVER" 'systemctl restart truescore'
echo "Done."
