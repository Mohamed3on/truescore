# truescore-web on Hetzner

Public URL: **https://truescore.mohamed3on.com**
Box: `root@65.108.153.112` (Hetzner CX22, Ubuntu 24.04, Helsinki)
DNS: A record at Cloudflare (`mohamed3on.com` zone), proxied (orange cloud)
TLS: Cloudflare edge (Flexible mode — edge ↔ origin is plain HTTP)

## Layout on the box

| | |
|---|---|
| App dir | `/opt/truescore` |
| .env | `/opt/truescore/.env` (PORT=80, Decodo creds, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `LLM_PROVIDER`, paths) |
| Code/cache state | `/var/lib/truescore/{cache.sqlite,cookies.json,maps-creds.json}` (legacy `cache.json` migrated on first start; `maps-creds.json` = last extension-seeded Maps session, `0600`) |
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

# check the seeded Maps session age (bgkey freshness) — empty hasCreds=false means re-seed by opening a Maps tab
ssh root@65.108.153.112 'curl -s localhost/api/maps-creds -H "x-truescore-seed: $(sed -n "s/^TRUESCORE_SEED_SECRET=//p" /opt/truescore/.env)"'

# clear the seeded Maps session (serves empty until the extension re-seeds)
ssh root@65.108.153.112 'rm -f /var/lib/truescore/maps-creds.json && systemctl restart truescore'

# NOTE: server-side bgkey minting was REMOVED (2026-07-02). Google serves any
# automated/CDP-driven browser a review-less Maps page regardless of proxy, headless
# vs headful, UA, or IP — proven by diffing an automated Chrome against a real one on
# the same machine (identical JS fingerprint, only the debug attachment differs). So
# there is no /api/maps-creds/renew and no TRUESCORE_MINT_INTERVAL_MIN. A genuinely
# expired session emits a `needs-reseed` event (see observability) and is healed by an
# extension reseed (a real browser). Watch for it:
ssh root@65.108.153.112 "journalctl -u truescore --no-pager --since today | grep 'type=needs-reseed'"

# tune cookie roll-forward cadence (minutes; 0 disables). The server refreshes the
# session-trust tokens (__Secure-1PSIDTS/3PSIDTS) via RotateCookies on this cadence
# + ~10s after boot, stretching session life between reseeds. This is the only
# server-side keepalive; it can't refresh the bgkey, only the cookie jar.
ssh root@65.108.153.112 'echo "TRUESCORE_COOKIE_REFRESH_MIN=30" >> /opt/truescore/.env && systemctl restart truescore'

# switch summarization model (llm.ts): gemini (default when unset) or openai
ssh root@65.108.153.112 'sed -i "s/^LLM_PROVIDER=.*/LLM_PROVIDER=gemini/" /opt/truescore/.env && systemctl restart truescore'
```

## Session observability (`[ts-event]`)

Every Maps-session lifecycle moment is emitted as one structured line
`[ts-event] type=<t> k=v …` AND mirrored to the `session_events` table in
`cache.sqlite` (durable across restarts, pruned to 14 days). This is the fast path
for "web is empty/0% — why": you no longer have to reconstruct it from scattered
`warn()` lines. Event types: `seed` (src=extension|mint|disk), `mint`
(result=ok|fail; a failed mint carries `page={title,tabs,english,consent,bodyLen}`
explaining why the Reviews UI didn't render), `rpc-stale` / `rpc-recovered` /
`rpc-stale-final` (the throttle-retry: recovered = transient throttle, stale-final =
genuine expiry → renewal), `throttle`, `cookie-rotate` (result=adopted|unchanged|
verify-empty|error), `health` (renewOk transitions), `fetch-fail` (status+body — 407
quota vs 4xx bgkey).

```bash
# live tail of just the session events
ssh root@65.108.153.112 "journalctl -u truescore -f -n0 | grep --line-buffered '\[ts-event\]'"

# durable history from sqlite (bun, since sqlite3 CLI isn't installed). Last 40:
ssh root@65.108.153.112 'set -a; . /opt/truescore/.env; set +a
  bun -e "const {Database}=require(\"bun:sqlite\");const p=process.env.TRUESCORE_CACHE_DB_PATH||\"/var/lib/truescore/cache.sqlite\";const db=new Database(p,{readonly:true});for(const r of db.prepare(\"SELECT ts,type,data FROM session_events ORDER BY ts DESC LIMIT 40\").all())console.log(new Date(r.ts).toISOString(),r.type,r.data)"'

# counts by type over the last day (is the cookie keepalive actually adopting? are mints failing?)
ssh root@65.108.153.112 'set -a; . /opt/truescore/.env; set +a
  bun -e "const {Database}=require(\"bun:sqlite\");const p=process.env.TRUESCORE_CACHE_DB_PATH||\"/var/lib/truescore/cache.sqlite\";const db=new Database(p,{readonly:true});const since=Date.now()-864e5;for(const r of db.prepare(\"SELECT type,count(*) n FROM session_events WHERE ts>? GROUP BY type ORDER BY n DESC\").all(since))console.log(String(r.n).padStart(5),r.type)"'
```

## Residential proxy (Decodo)

All Google fetches in `browser.ts` go through a Decodo residential proxy, set in `/opt/truescore/.env`:

```bash
TRUESCORE_PROXY_SERVER=http://gate.decodo.com:7000     # rotating gateway
TRUESCORE_PROXY_USER=user-<decodo-id>-continent-eu     # rotating, EU exits
TRUESCORE_PROXY_PASS=<decodo-password>
```

Use the **rotating** gateway (`gate.decodo.com:7000`), not a sticky session. It hands out a fresh EU IP per request, so a dead exit IP costs only one request - the `googleFetch` retry lands on a new IP - and the ~13 concurrent fetches per lookup (preview + relevant + newest + 10 chips) spread across IPs instead of hammering one. `http` is the fastest scheme and safe here: HTTPS targets are TLS-tunneled end-to-end via CONNECT regardless of scheme, and the only payload is public reviews.

### "Google is busy upstream" / repeated 502 or 522

This is a `googleFetch` 5xx from the **proxy**, not a Google outage - the public site and *cached* places keep working (cache skips the proxy) while *fresh* lookups fail. `CONNECT tunnel failed, 502` means the exit IP is dead; `522` is a Cloudflare connection-timeout, usually under the concurrent fan-out.

Reproduce from the box - fetch Google through the proxy:

```bash
ssh root@65.108.153.112 'set -a; . /opt/truescore/.env; set +a
  curl -sS -x "$TRUESCORE_PROXY_SERVER" -U "$TRUESCORE_PROXY_USER:$TRUESCORE_PROXY_PASS" \
    --max-time 20 -o /dev/null -w "HTTP %{http_code}\n" https://www.google.com/maps?hl=en'
```

`200` on a single request but failures under load means rate-limiting; failures on *every* request means a dead endpoint - point `TRUESCORE_PROXY_SERVER`/`TRUESCORE_PROXY_USER` at a known-good endpoint and `systemctl restart truescore`.

### Endpoint reference

- **Rotating (preferred):** `http://gate.decodo.com:7000`, username `user-<decodo-id>-continent-eu`. Username params (`continent-eu`, `sessionduration-N`) are honored here.
- **Sticky pool:** ports `gate.decodo.com:10001`-`10010`, bare username `<decodo-id>`. Each port is one fixed exit IP and **ignores** the geo param (the port pins the IP).
- **Avoid** a single long sticky session (`...-sessionduration-60` on one port): if that IP dies, every fresh lookup fails until it rotates. This caused a full outage on 2026-05-28.

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
