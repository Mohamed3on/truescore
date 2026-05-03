# Cloudflare Workers migration — SHELVED

## Verdict (2026-05-03)

Migration is shelved. **truescore-web stays on Hetzner** at https://truescore.mohamed3on.com.

The blocker is **workerd issue [#2712](https://github.com/cloudflare/workerd/issues/2712)** — `socket.startTls()` after any plaintext I/O (including HTTP CONNECT) fails with a generic `TLS Handshake Failed.` Open since 2024-09, unfixed. Until it closes, Decodo Residential Proxies (CONNECT/SOCKS5) are unusable from Workers.

## Diagnostic results (kept for re-test)

5 probes deployed to `https://truescore.mohamed3on.workers.dev`:

| Probe | Path | Result |
|---|---|---|
| `/probe-direct` | raw `connect+secureTransport:'on'` to Google | ✅ 200 |
| `/probe-fetch` | Workers native `fetch()` to Google | ✅ 200 |
| `/probe-starttls` | `connect+'starttls'` then immediate `startTls()` to Google | ✅ 200 |
| `/probe` | CONNECT to Decodo, `startTls()` to Google | ❌ TLS Handshake Failed |
| `/probe` to ipinfo.io via Decodo | CONNECT to Decodo, `startTls()` to ipinfo | ❌ TLS Handshake Failed |
| `/probe-noverify` (no expectedServerHostname) | same as above | ❌ identical error |

**Conclusions:**
- Workers' raw TLS works (probes 1–3).
- The failure is **specifically** post-CONNECT `startTls()`, identical for any HTTPS target.
- Not Google-specific. Not Decodo-specific (workerd #2712 user hit it on SMTP).
- Not SNI/cert validation — `expectedServerHostname` makes no difference.
- Workers `fetch()` reaches Google (probe 2) but **cannot bypass Google's CF-IP block on RPC endpoints** — `listugcposts` returns `[null,null,null,null,null,1]` (33 bytes, the "blocked" payload) instead of real review data. So a proxy is genuinely required.

After this wrap-up the spike was reverted to a single `/probe` endpoint as a canary; the diagnostic helpers are gone but the methodology is here.

## What it would cost to unblock today

| Path | $/mo extra | Effort |
|---|---|---|
| Stay on Hetzner (chosen) | 0 | 0 |
| Decodo "Site Unblocker" REST tier (if available on this account) | likely +$50–100 | medium — port `browser.ts` to `fetch(siteunblocker, {url})` |
| Switch to scraper-API provider (ScrapFly / ScraperAPI / Bright Data Web Unlocker) | +$30–200 at typical traffic | medium — same shape of port |
| Wait for workerd #2712 fix | 0 | just patience |

## When to re-attempt

1. workerd #2712 is closed/fixed → `wrangler deploy` from this dir, hit `/probe?url=https://www.google.com/robots.txt`, expect 200 with real `robots.txt` content. If it works, the porting plan below is unblocked.
2. We decide we want to pay for a Web Scraping API → swap `googleFetchViaProxy` in `src/proxy.ts` for a `fetch()` to the scraper API endpoint. Everything else (porting plan below) is unchanged.

## Porting plan (deferred — for when unblocked)

1. Copy `gmaps.ts`, `histogram.ts`, `highlights.ts`, `gemini.ts`, `resolve.ts` from `truescore-web/` and swap `googleFetch` to use `proxy.ts`. **No business-logic changes** — these only touch `googleFetch` / `fetchPlacePreview`.
2. Replace `cache.ts` Bun.file with KV: `wrangler kv namespace create STATE`, swap `Bun.file/Bun.write` for `env.STATE.get/put`. Same shape.
3. Convert `server.ts` `Bun.serve({routes})` to Workers `fetch(req, env)` with a `switch` on `url.pathname`. Pass `env` down to anything that reads cookies/cache.
4. Move `index.html`, `client.ts`, `style.css` into `public/` and add `assets = "./public"` to `wrangler.toml`. One Worker serves UI + API.
5. `wrangler secret put GEMINI_API_KEY` (proxy secrets already set).
6. Verify on `truescore.mohamed3on.workers.dev` for a week alongside Hetzner.
7. DNS cutover: switch `truescore.mohamed3on.com` from Hetzner A-record to Workers route (`pattern = "truescore.mohamed3on.com/*"` in `wrangler.toml`).
8. Watch for 24h, then `ssh root@65.108.153.112 'systemctl stop truescore'` and cancel the box.

## State of the world

The local `truescore-workers/` scratch folder was deleted on 2026-05-03 once
this postmortem moved here. Nothing of value was lost:

- The deployed canary at `https://truescore.mohamed3on.workers.dev/probe` is
  still live; redeploy is just `wrangler init` + the porting plan above.
- Decodo proxy creds remain set as Worker secrets (`TRUESCORE_PROXY_HOST`,
  `_PORT`, `_USER`, `_PASS`). Verify with `wrangler secret list` against the
  `truescore` worker.
- The shelved Worker source was three files: `package.json` (workers-types +
  wrangler + typescript), `wrangler.toml` (compat 2026-04-15, KV+route
  stanzas commented out), and `src/{index.ts, proxy.ts}` (CONNECT + startTls
  + HTTP/1.1 client; the workerd #2712 blocker lives in `startTls()`).

## Useful commands when re-attempting

```bash
wrangler deploy
wrangler tail
curl 'https://truescore.mohamed3on.workers.dev/probe?url=https%3A%2F%2Fwww.google.com%2Frobots.txt'
echo '<value>' | wrangler secret put TRUESCORE_PROXY_HOST
wrangler kv namespace create STATE   # only when ready to port the cache
```
