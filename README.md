# truescore

Monorepo for the TrueScore browser extension and the truescore-web (Hetzner-hosted)
SPA. Both replace inflated star ratings with scores that mean something.

## Install

Grab the latest **[`truescore.zip`](https://github.com/Mohamed3on/truescore/releases/latest)** from Releases and unzip it, then in `chrome://extensions` turn on **Developer mode** → **Load unpacked** → pick the `truescore/` folder. Works in any Chromium browser (Chrome, Edge, Brave, Arc).

Scores and sorting work with no setup; the AI review summaries take an optional (free) API key. Full walkthrough — keys, and building from source — in the [extension README](packages/extension/README.md#install--setup).

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

CI:

- Pushes to `main` touching `packages/web/`, `packages/gmaps-shared/`, or
  `deploy/` trigger `.github/workflows/deploy-web.yml` which rsyncs and restarts
  the Hetzner service.
- Pushes touching `packages/extension/` or `packages/gmaps-shared/` trigger
  `.github/workflows/release-extension.yml`, which builds the extension and
  publishes `truescore.zip` to [GitHub Releases](https://github.com/Mohamed3on/truescore/releases)
  via semantic-release (versioned from Conventional Commits).

## Where to look

- Web ops: [`packages/web/deploy/HETZNER.md`](packages/web/deploy/HETZNER.md)
- Extension dev: [`packages/extension/CLAUDE.md`](packages/extension/CLAUDE.md)
- Shelved Workers migration (postmortem + porting plan): [`packages/web/WORKERS-SHELVED.md`](packages/web/WORKERS-SHELVED.md)
