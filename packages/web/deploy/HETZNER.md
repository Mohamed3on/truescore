# truescore-web on Hetzner

Public URL: **https://truescore.mohamed3on.com**
Box: `root@65.108.153.112` (Hetzner CX22, Ubuntu 24.04, Helsinki)
DNS: A record at Cloudflare (`mohamed3on.com` zone), proxied (orange cloud)
TLS: Cloudflare edge (Flexible mode — edge ↔ origin is plain HTTP)

## Layout on the box

| | |
|---|---|
| App dir | `/opt/truescore` |
| .env | `/opt/truescore/.env` (PORT=80, Decodo creds, paths) |
| Code/cache state | `/var/lib/truescore/{cache.sqlite,cookies.json}` (legacy `cache.json` migrated on first start) |
| systemd unit | `/etc/systemd/system/truescore.service` |
| Service user | `truescore` |
| Bun | `/usr/local/bin/bun` |

The bun process binds port 80 directly via `AmbientCapabilities=CAP_NET_BIND_SERVICE` in the systemd unit — no reverse proxy, no cloudflared.

## Common tasks

```bash
# tail logs (live)
ssh root@65.108.153.112 'journalctl -u truescore -f'

# bounce
ssh root@65.108.153.112 'systemctl restart truescore'

# status + memory
ssh root@65.108.153.112 'systemctl status truescore --no-pager'

# inspect env / config
ssh root@65.108.153.112 'cat /opt/truescore/.env'
ssh root@65.108.153.112 'cat /etc/systemd/system/truescore.service'

# look at what's listening
ssh root@65.108.153.112 'ss -tlnp | grep bun'

# cache + cookies on disk
ssh root@65.108.153.112 'ls -la /var/lib/truescore/'

# wipe place cache (forces fresh fetches)
ssh root@65.108.153.112 'rm -f /var/lib/truescore/cache.sqlite* && systemctl restart truescore'

# wipe cookies (forces re-bake via proxy)
ssh root@65.108.153.112 'rm /var/lib/truescore/cookies.json && systemctl restart truescore'
```

## Deploy code changes

From the repo root locally:

```bash
SERVER=root@65.108.153.112 ./deploy/sync.sh
```

This rsyncs source (excluding `.env`, `node_modules`, `.git`, `deploy/`), runs `bun install` on the server, and restarts the service. Each box keeps its own `.env`.

## End-to-end smoke test

```bash
curl -sS -X POST https://truescore.mohamed3on.com/api/lookup \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://maps.app.goo.gl/L3iA21n3V1yp7F6M9"}' | jq .name,.score.scorePct,.histogram
```

Expect a name, a score 0–100, and a 5-element histogram array.

## Fresh-box bootstrap (full reinstall)

```bash
# 1. install deps + systemd units (run on the box as root)
ssh root@<new-ip> 'bash -s' < deploy/install.sh

# 2. create /opt/truescore/.env on the box (one-time, from local)
scp .env root@<new-ip>:/opt/truescore/.env
ssh root@<new-ip> 'chown truescore:truescore /opt/truescore/.env && sed -i "s/^PORT=.*/PORT=80/" /opt/truescore/.env'

# 3. push code
SERVER=root@<new-ip> ./deploy/sync.sh

# 4. enable services
ssh root@<new-ip> 'systemctl enable --now truescore'

# 5. update Cloudflare DNS A record to point truescore.mohamed3on.com → <new-ip>
```
