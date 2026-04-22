# Changelog

Only user-visible changes. Latest first. Before v1.0.0, each minor
version gets one summary entry here; for line-level detail, read the
commit log between the two adjacent tags.

## v0.5.0 — 2026-04-22

- In-process self-upgrade: clickable topbar status runs a GitHub check, downloads + SHA256-verifies the new binary, keeps the old one as `.bak`, and `execv`s the same PID so the user's `serve` terminal rolls over cleanly. Popover shows the real release notes and a `vA → vB` header.
- Per-session VS Code (coder/code-server), mirrors the FileBrowser flow — one-click spawn, "Open VS Code ↗" lands in the session's workdir, clean Stop.
- Real BotDock logo replaces the placeholder SVG in the topbar, browser favicon, and README header; Notes panel gains `A- / A+` font-size control persisted across reloads.
- Keyboard: Send only delivers text now — Enter is its own quick key, so typing into a Claude prompt no longer auto-submits.
- Workspace remembers the last-selected session across reloads (including update-triggered restarts); transcript view auto-follows the latest page so new turns advance the view instead of pinning it.
- Release workflow builds the release body from CHANGELOG.md + full commit messages since the previous tag, so both the GitHub release page and the in-app update popover get the "why", not just subjects.
- Daemon restart now resets filebrowser + code-server state so stale "Open" links don't point at dead tunnels.
- Fixes: `installed.toml` rewrite preserves every tool's block (installing ttyd no longer wipes filebrowser and vice versa); supervisor port-discovery no longer trips `pipefail` when the embedded process died inside a live tmux; tool-lifecycle breadcrumbs use `info` instead of `error` in the events panel.

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
