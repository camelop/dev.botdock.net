# BotDock

Local agent command center. Manage SSH keys, machines (with jump host chains), secrets,
and push reusable context to agent sessions running on those machines.

Design is in [`design/overview.md`](design/overview.md).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/camelop/dev.botdock.net/main/install.sh | bash
```

Re-run the same command to upgrade. Supported platforms: `linux-x64`, `linux-arm64`,
`darwin-x64`, `darwin-arm64`.

Runtime prereqs on the machine running `botdock serve`: `ssh`, `ssh-keygen`, `tmux`.

## Getting started

```sh
# 1. Pick a directory to hold your BotDock state. This is your "data dir".
mkdir -p ~/botdock && cd ~/botdock
botdock init .

# 2. Start the server (default: http://127.0.0.1:4717).
botdock serve

# 3. Open the UI in a browser and create keys → machines → secrets.
```

Everything BotDock knows is under the data dir. Back it up or keep it in git (but
remember `private/` holds plaintext keys and secrets in v1 — don't commit those).

## CLI

All commands take an optional `--home <dir>` (defaults to `$BOTDOCK_HOME` or `cwd`).

```
botdock init [dir]                    scaffold a data directory
botdock key create <nickname>         generate ed25519
botdock key import <nick> <path>      import an existing OpenSSH private key
botdock key list / show / delete
botdock machine add <name> --host H --user U --key K [--port N] [--tag T]
botdock machine list / show / edit / remove
botdock machine test <name>           dial through the full jump chain
botdock secret set <name>             reads value from stdin
botdock secret list / show / remove
botdock serve [--dev]                 run the web server
botdock --version
```

## Development

```sh
bun install
bun test
bun run typecheck
bun run web:dev       # Vite on :5173, proxies /api → :4717
bun src/cli.ts serve --dev   # API only, frontend comes from Vite
bun run build         # compile ./dist-bin/botdock for the host
bun run build:all     # cross-compile all four platforms
```

## Releases

Push a `v*` tag (e.g. `git tag v0.1.0 && git push origin v0.1.0`). The
`release` workflow cross-compiles the four platforms and attaches them
(plus `SHA256SUMS`) to the GitHub Release.

## Status

- **M0** storage + CLI CRUD · **done**
- **M1** web UI + REST/WS · **done**
- **M2** remote session (`generic-cmd`) · not started
- **M3** Claude Code session + transcript · not started
- **M4** resource push (mirrored to `.botdock/`) · not started
- **M5** git-repo resources + jump host polish · not started
