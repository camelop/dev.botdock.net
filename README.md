# BotDock

Single-user local command center for agent sessions. Manage SSH keys, machines
(with jump host chains), secrets, and launch `claude-code` or generic shell
sessions on those machines — each session lives in a remote `tmux`, streams
back event + raw logs, and (for Claude Code) mirrors the transcript jsonl.
Embedded React UI ships inside the binary; no external database, everything
persists as TOML/NDJSON under the data dir.

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

## What's in the UI

- **Dashboard** — counts + recent-session list, "+ New session" launcher.
- **Sessions → War Room** — boring-avatar grid of live sessions with pending/running
  state badges, acks, geographic view.
- **Sessions → Workspace** — three-column view: grouped session list
  (Needs attention / Active / Other) with aliases, terminal in the middle,
  meta + transcript + events on the right.
- **Sessions → List** — table + detail modal (terminal, transcript, events).
- **Machines → Machines / Forwards / Terminals** — SSH targets, user-managed
  port forwards (with an optional web proxy for local `-L` forwards), and
  lazy-connected per-machine terminals.
- **Private → Keys / Secrets** — ed25519 key management + secret storage.

## Status

- **M0** storage + CLI CRUD · **done**
- **M1** web UI + REST/WS · **done**
- **M2** remote session (`generic-cmd`) · **done**
- **M3** Claude Code session + transcript sync · **done**
- **M4** port forwards + per-machine / per-session ttyd terminals · **done**
- **M5** resource push (mirrored to `.botdock/`) · in design
- **M6** git-repo resources + jump host polish · not started

The Budgets tab (Anthropic cost auto-refresh) is temporarily disabled while
the integration is hardened.
