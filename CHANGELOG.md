# Changelog

Only user-visible changes. Latest first.

## v0.4.8 — 2026-04-22

- Workspace remembers the last-selected session across reloads (via `localStorage`), so update-triggered restarts drop you back where you were.
- VS Code open now lands in the session's workdir — start script echoes the tilde-expanded path, daemon stores it on the session, `Open VS Code ↗` appends `?folder=<abs>`.
- Update popover header shows `vA → vB` when an update is available (was just `current: vA`).
- Release workflow now builds the release body from CHANGELOG.md + full commit messages since the previous tag (so `/releases/latest.body` and the in-app popover get the "why", not just titles).

## v0.4.7 — 2026-04-22

- Fix: code-server (and ttyd/filebrowser) install scripts crashed with "NEW_TTYD_PATH: unbound variable" because the shared marker-rewrite snippet read NEW_* vars the caller didn't set under `set -euo pipefail`. Now defaults each to empty via `${VAR:-}`.

## v0.4.6 — 2026-04-22

- Self-update fix: reexec stopped the new daemon with "unknown command: /$bunfs/..." because `process.argv.slice(1)` in a compiled Bun binary leaks the virtual /$bunfs entry. Now uses slice(2) and strips any /$bunfs/ paths defensively.
- Keyboard: Send button only sends the text box contents now (no auto-Enter). Enter is its own `↩ Enter` quick key.

## v0.4.5 — 2026-04-22

- Update popover now shows the actual release notes (GitHub-generated from commit titles) instead of a generic description of what upgrading does.

## v0.4.4 — 2026-04-22

- Per-session VS Code button (`coder/code-server`), mirrors the FileBrowser flow — one click to spawn, segmented Open/Stop group when running; proxy strips the `/api/sessions/:id/code` prefix since code-server has no native base-path.
- Daemon boot now resets `filebrowser_*` and `codeserver_*` ports on every session so stale "Open" links after a `botdock serve` restart don't point at dead tunnels.

## v0.4.3 — 2026-04-22

- In-process self-upgrade: click the topbar status to check GitHub for a newer release and install it in-place (download → SHA256 verify → preflight → `.bak` + hot-swap → `execv` same PID; frontend auto-reloads when the new daemon is up).

## v0.4.2 — 2026-04-22

- Top-bar logo bumped 24 → 32 px; README gets a header logo.
- Notes panel: `A-` / `A+` buttons left of the close × for persistent font-size control (10–22 px, localStorage).

## v0.4.1 — 2026-04-22

- Real BotDock logo now sits in the top bar and tab favicon (replaces the placeholder "three bars" SVG).

## v0.4.0 — 2026-04-21

- Resume an existing Claude Code conversation from the New Session modal.
- New full-screen Workspace (three-column hub) with aliases, accent colors, tags, and drag-to-persist preferences.
- Per-session file browser — one-click spawn of filebrowser.org scoped to the workdir, reverse-proxied at `/api/sessions/:id/files/`.
- Per-session floating notepad: draggable, resizable, auto-saves to `sessions/<id>/notes.md`.
- Transcript is now server-paginated — long sessions open instantly; other pages load on click.
- New "syncing" activity state while the poller drains a backlog; hard reload when the daemon restarts.
- Action bar reshuffled: zoom −/%/+, Keyboard, FileBrowser group, Notes, and Open-in-Workspace jumps.
- Advanced New Session options: custom launch command and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` opt-in.
- Dashboard gets a "⇲ Workspace" button; Needs-attention group tints amber when non-empty.
- Fixes: ControlMaster bottleneck that stalled concurrent sessions, ENOBUFS on multi-MB transcripts, misreported "running" after CC idle-state writes.
