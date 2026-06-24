# truescore

Monorepo for the TrueScore browser extension and the truescore-web (Hetzner-hosted)
SPA. Both replace inflated star ratings with scores that mean something.

## Layout

| Package | What |
|---|---|
| [`packages/extension`](packages/extension) | Browser extension. Build with `bun run build:extension`. |
| [`packages/web`](packages/web) | Bun web app deployed to Hetzner. Run locally with `bun --cwd packages/web run dev`. |
| [`packages/gmaps-shared`](packages/gmaps-shared) | URL builders, response parsers, score math, preview-JSON readers used by both. |

Storage, HTTP transport, DOM, and server routing stay per-package — they diverge
enough that abstraction would obscure more than it shares.

## Common commands

```bash
bun install                              # set up workspaces
bun run build:extension                  # rebuilds packages/extension/truescore/
bun --cwd packages/web run dev           # local web dev server
SERVER=root@65.108.153.112 ./deploy/sync.sh   # deploy web to Hetzner
```

CI: pushes to `main` that touch `packages/web/`, `packages/gmaps-shared/`, or
`deploy/` trigger `.github/workflows/deploy-web.yml` which rsyncs and restarts
the Hetzner service.

## Where to look

- Install the extension: [`packages/extension/README.md`](packages/extension/README.md#install--setup)
- Web ops: [`packages/web/deploy/HETZNER.md`](packages/web/deploy/HETZNER.md)
- Extension dev: [`packages/extension/CLAUDE.md`](packages/extension/CLAUDE.md)
- Shelved Workers migration (postmortem + porting plan): [`packages/web/WORKERS-SHELVED.md`](packages/web/WORKERS-SHELVED.md)
