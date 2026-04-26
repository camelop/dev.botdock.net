<p align="center"><img src="assets/logo.png" alt="BotDock" width="128" height="128"></p>

# BotDock

Single-user local command center for agent sessions. Manage SSH keys, machines
(with jump host chains), secrets, and curated context (git repos, markdown
snippets, file bundles), then launch `claude-code` or generic shell sessions
that can inherit any of it — each session lives in a remote `tmux`, streams
back event + raw logs, and (for Claude Code) mirrors the transcript jsonl.
Embedded React UI ships inside the binary; no external database, everything
persists as TOML/NDJSON under the data dir.

User-visible changes: [`CHANGELOG.md`](CHANGELOG.md).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/camelop/dev.botdock.net/main/install.sh | bash
```

Re-run the same command to upgrade. Supported platforms: `linux-x64`, `linux-arm64`,
`darwin-x64`, `darwin-arm64`.

Runtime prereqs on the machine running `botdock serve`: `ssh`, `ssh-keygen`, `tmux`, `rsync` (the last is used for ＋Context push; BotDock will auto-install it on target machines if missing).

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

## What's in the UI

- **Dashboard** — counts + recent-session list, "+ New session" launcher.
- **Sessions → Workspace / Card / List** — three views on the same
  sessions: three-column workspace (grouped sidebar · terminal ·
  transcript + events), boring-avatar card grid, or flat table with a
  detail modal.
- **Context → Git Repos / Markdown / File Bundles** — curate reusable
  inputs you can push into any session's workdir with one click;
  optional deploy keys for private clones, markdown notes edited in
  Monaco, arbitrary directory trees imported as folders or tar/zip.
- **Machines → Machines / Forwards / Terminals** — SSH targets with
  jump-host chains and a reserved `local` loopback entry, user-managed
  port forwards (with an optional web proxy for `-L` forwards), and
  lazy-connected per-machine terminals.
- **Private → Keys / Secrets** — ed25519 key management + secret
  storage.
